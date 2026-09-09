/* ============================================================
   Baseline CourtLog — clip capture and review
   Camera recording, line-call marks and a clip library, all held
   in IndexedDB on this device. No upload, no server, no account.
   Exposes window.CourtLogClips for app.js to call into.
   ============================================================ */

window.CourtLogClips = (function () {
  'use strict';

  var DB_NAME = 'courtlog-clips';
  var DB_VERSION = 1;
  var STORE = 'clips';

  var MAX_MS = 10 * 60 * 1000;   // hard stop, so a forgotten recording cannot fill the phone
  var WARN_MS = 3 * 60 * 1000;   // gentle nudge

  var CALL_LABELS = { in: 'In', out: 'Out', note: 'Mark' };

  /* ---------- helpers ---------- */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clock(ms) {
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function megabytes(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* ---------- IndexedDB ---------- */

  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser cannot store clips.'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Could not open clip storage.')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function putClip(clip) { return tx('readwrite', function (s) { return s.put(clip); }); }
  function getClip(id) { return tx('readonly', function (s) { return s.get(id); }); }
  function deleteClip(id) { return tx('readwrite', function (s) { return s.delete(id); }); }
  function clearClips() { return tx('readwrite', function (s) { return s.clear(); }); }

  function allClips() {
    return tx('readonly', function (s) { return s.getAll(); }).then(function (rows) {
      return (rows || []).sort(function (a, b) {
        return a.createdAt < b.createdAt ? 1 : -1;
      });
    });
  }

  /* ---------- recorder state ---------- */

  var stream = null;
  var recorder = null;
  var chunks = [];
  var marks = [];
  var startedAt = 0;
  var tickTimer = null;
  var facing = 'environment';
  var warned = false;
  var reviewing = null;
  var reviewUrl = null;

  function pickMimeType() {
    var candidates = [
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function showError(msg) {
    var box = $('camError');
    box.textContent = msg;
    box.hidden = false;
  }

  function clearError() { $('camError').hidden = true; }

  function setCallsEnabled(on) {
    ['callIn', 'callOut', 'callNote'].forEach(function (id) { $(id).disabled = !on; });
  }

  /* ---------- camera ---------- */

  function startCamera() {
    clearError();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('This browser cannot reach the camera. Try Safari on iPhone or Chrome on Android.');
      return;
    }
    if (!window.isSecureContext) {
      showError('The camera only works over a secure connection. Open the app over HTTPS rather than a plain address.');
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    }).then(function (s) {
      stream = s;
      var v = $('camPreview');
      v.srcObject = s;
      v.classList.toggle('mirrored', facing === 'user');
      v.play().catch(function () { /* autoplay attribute covers this */ });

      $('camEmpty').hidden = true;
      $('camStart').hidden = true;
      $('recToggle').hidden = false;
      $('camFlip').hidden = false;
      $('camStop').hidden = false;
    }).catch(function (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        showError('Camera access was blocked. Allow the camera for this site in your browser settings, then try again.');
      } else if (err && err.name === 'NotFoundError') {
        showError('No camera found on this device.');
      } else {
        showError('Could not start the camera. ' + ((err && err.message) || ''));
      }
    });
  }

  function stopCamera() {
    if (recorder && recorder.state === 'recording') stopRecording();
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    var v = $('camPreview');
    v.srcObject = null;

    $('camEmpty').hidden = false;
    $('camStart').hidden = false;
    $('recToggle').hidden = true;
    $('camFlip').hidden = true;
    $('camStop').hidden = true;
    clearError();
  }

  function flipCamera() {
    facing = facing === 'environment' ? 'user' : 'environment';
    var wasRecording = recorder && recorder.state === 'recording';
    if (wasRecording) stopRecording();
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    startCamera();
  }

  /* ---------- recording ---------- */

  function startRecording() {
    if (!stream) return;
    clearError();

    var mime = pickMimeType();
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      showError('This browser cannot record video.');
      return;
    }

    chunks = [];
    marks = [];
    warned = false;
    startedAt = Date.now();

    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = finishRecording;
    recorder.start(1000);

    $('recToggle').textContent = 'Stop recording';
    $('recToggle').classList.add('is-recording');
    $('recBadge').hidden = false;
    $('camFlip').hidden = true;
    setCallsEnabled(true);
    renderTally();

    tickTimer = setInterval(function () {
      var ms = Date.now() - startedAt;
      $('recTime').textContent = clock(ms);
      if (!warned && ms > WARN_MS) {
        warned = true;
        toast('Three minutes in. Shorter clips are easier to review.');
      }
      if (ms > MAX_MS) stopRecording();
    }, 250);
  }

  function stopRecording() {
    if (!recorder || recorder.state !== 'recording') return;
    clearInterval(tickTimer);
    tickTimer = null;
    recorder.stop();

    $('recToggle').textContent = 'Start recording';
    $('recToggle').classList.remove('is-recording');
    $('recBadge').hidden = true;
    $('camFlip').hidden = !stream;
    setCallsEnabled(false);
  }

  function posterFrame() {
    return new Promise(function (resolve) {
      try {
        var v = $('camPreview');
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) { resolve(null); return; }
        var scale = 320 / w;
        var c = document.createElement('canvas');
        c.width = 320;
        c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.7);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function finishRecording() {
    var durationMs = Date.now() - startedAt;
    var type = (recorder && recorder.mimeType) || 'video/webm';
    var blob = new Blob(chunks, { type: type });
    chunks = [];

    if (!blob.size) {
      showError('The recording came back empty and was not saved.');
      return;
    }

    posterFrame().then(function (poster) {
      var clip = {
        id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        createdAt: new Date().toISOString(),
        date: todayISO(),
        durationMs: durationMs,
        mime: type,
        size: blob.size,
        marks: marks.slice(),
        blob: blob,
        poster: poster
      };
      marks = [];
      return putClip(clip).then(function () {
        renderLibrary();
        renderTally();
        /* app.js owns sessions, so it decides what the link prompt offers. */
        if (api.onClipSaved) api.onClipSaved(clip);
        else toast('Clip saved. ' + clock(durationMs) + ', ' + megabytes(blob.size) + '.');
      });
    }).catch(function (err) {
      showError('Could not save the clip. ' + ((err && err.message) || 'Storage may be full.'));
    });
  }

  /* ---------- line calls ---------- */

  function addMark(type) {
    if (!recorder || recorder.state !== 'recording') return;
    marks.push({ t: Date.now() - startedAt, type: type });
    renderTally();

    var btn = $(type === 'in' ? 'callIn' : type === 'out' ? 'callOut' : 'callNote');
    btn.classList.add('pulse');
    setTimeout(function () { btn.classList.remove('pulse'); }, 220);
  }

  function renderTally() {
    var line = $('callTally');
    if (!recorder || recorder.state !== 'recording') {
      line.textContent = 'Start recording to mark calls.';
      return;
    }
    if (!marks.length) {
      line.textContent = 'Recording. No calls marked yet.';
      return;
    }
    var counts = { in: 0, out: 0, note: 0 };
    marks.forEach(function (m) { counts[m.type] += 1; });
    line.textContent = counts.in + ' in, ' + counts.out + ' out, ' + counts.note +
      ' mark' + (counts.note === 1 ? '' : 's') + ' so far.';
  }

  /* ---------- library ---------- */

  function renderLibrary() {
    return allClips().then(function (rows) {
      var list = $('clipList');
      list.textContent = '';
      $('clipCount').textContent = rows.length;

      if (!rows.length) {
        var li = el('li');
        li.appendChild(el('div', 'empty', 'No clips yet. Turn the camera on and record a rally.'));
        list.appendChild(li);
      } else {
        rows.forEach(function (c) { list.appendChild(clipRow(c)); });
      }

      updateStorageLine(rows);
      return rows.length;
    }).catch(function () {
      $('clipList').textContent = '';
      var li = el('li');
      li.appendChild(el('div', 'empty', 'Clip storage is unavailable in this browser.'));
      $('clipList').appendChild(li);
      return 0;
    });
  }

  function clipRow(c) {
    var li = el('li', 'clip');

    var btn = el('button', 'clip-open');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open clip from ' + c.date);

    var thumb = el('span', 'clip-thumb');
    if (c.poster) {
      var img = document.createElement('img');
      img.src = URL.createObjectURL(c.poster);
      img.alt = '';
      img.onload = function () { URL.revokeObjectURL(img.src); };
      thumb.appendChild(img);
    }
    thumb.appendChild(el('span', 'clip-dur', clock(c.durationMs)));
    btn.appendChild(thumb);

    var meta = el('span', 'clip-meta');
    meta.appendChild(el('span', 'clip-date', new Date(c.createdAt)
      .toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' · ' +
      new Date(c.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));

    var counts = { in: 0, out: 0, note: 0 };
    (c.marks || []).forEach(function (m) { counts[m.type] += 1; });
    var summary = (c.marks && c.marks.length)
      ? counts.in + ' in · ' + counts.out + ' out'
      : 'No calls marked';
    meta.appendChild(el('span', 'clip-sub', summary + ' · ' + megabytes(c.size)));
    if (c.sessionId) meta.appendChild(el('span', 'clip-link', 'Linked to a session'));
    btn.appendChild(meta);

    btn.addEventListener('click', function () { openReview(c.id); });
    li.appendChild(btn);
    return li;
  }

  function updateStorageLine(rows) {
    var used = rows.reduce(function (a, c) { return a + (c.size || 0); }, 0);
    var line = $('storageLine');
    var text = rows.length
      ? rows.length + ' clip' + (rows.length === 1 ? '' : 's') + ' using ' + megabytes(used) + ' on this device.'
      : 'Clips are stored on this device only.';

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        if (est && est.quota) {
          var freeMb = (est.quota - (est.usage || 0)) / (1024 * 1024);
          line.textContent = text + ' Roughly ' + Math.round(freeMb) + ' MB of room left.';
          line.classList.toggle('tight', freeMb < 200);
          return;
        }
        line.textContent = text;
      }).catch(function () { line.textContent = text; });
    } else {
      line.textContent = text;
    }
  }

  /* ---------- review ---------- */

  function openReview(id) {
    getClip(id).then(function (c) {
      if (!c) return;
      reviewing = c;

      if (reviewUrl) URL.revokeObjectURL(reviewUrl);
      reviewUrl = URL.createObjectURL(c.blob);

      var v = $('clipVideo');
      v.src = reviewUrl;

      $('clipTitle').textContent = new Date(c.createdAt)
        .toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      $('clipMeta').textContent = clock(c.durationMs) + ' · ' + megabytes(c.size);

      var host = $('clipMarks');
      host.textContent = '';
      if (!c.marks || !c.marks.length) {
        host.appendChild(el('p', 'hint', 'No calls were marked on this clip.'));
      } else {
        c.marks.forEach(function (m) {
          var chip = el('button', 'mark mark-' + m.type);
          chip.type = 'button';
          chip.appendChild(el('b', null, CALL_LABELS[m.type]));
          chip.appendChild(document.createTextNode(' ' + clock(m.t)));
          chip.addEventListener('click', function () {
            /* back up a beat so you see the ball coming down, not just the landing */
            v.currentTime = Math.max(0, (m.t - 1200) / 1000);
            v.play().catch(function () {});
          });
          host.appendChild(chip);
        });
      }

      $('clipDelete').textContent = 'Delete clip';
      $('clipModal').hidden = false;
      document.body.style.overflow = 'hidden';
    });
  }

  function closeReview() {
    var v = $('clipVideo');
    v.pause();
    v.removeAttribute('src');
    v.load();
    if (reviewUrl) { URL.revokeObjectURL(reviewUrl); reviewUrl = null; }
    reviewing = null;
    $('clipModal').hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- toast bridge ---------- */

  function toast(msg) {
    if (window.CourtLogToast) window.CourtLogToast(msg);
  }

  /* ---------- public surface ---------- */

  function init() {
    $('camStart').addEventListener('click', startCamera);
    $('camStop').addEventListener('click', stopCamera);
    $('camFlip').addEventListener('click', flipCamera);

    $('recToggle').addEventListener('click', function () {
      if (recorder && recorder.state === 'recording') stopRecording();
      else startRecording();
    });

    $('callIn').addEventListener('click', function () { addMark('in'); });
    $('callOut').addEventListener('click', function () { addMark('out'); });
    $('callNote').addEventListener('click', function () { addMark('note'); });

    $('clipAnalyse').addEventListener('click', function () {
      if (!reviewing) return;
      var id = reviewing.id;
      closeReview();
      if (api.onAnalyse) api.onAnalyse(id);
    });

    $('clipClose').addEventListener('click', closeReview);
    $('clipModal').addEventListener('click', function (ev) {
      if (ev.target === this) closeReview();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('clipModal').hidden) closeReview();
    });

    var armed = false;
    $('clipDelete').addEventListener('click', function () {
      if (!reviewing) return;
      if (!armed) {
        armed = true;
        this.textContent = 'Tap again to delete';
        var self = this;
        setTimeout(function () { armed = false; self.textContent = 'Delete clip'; }, 4000);
        return;
      }
      armed = false;
      var id = reviewing.id;
      closeReview();
      deleteClip(id).then(function () {
        toast('Clip deleted.');
        renderLibrary();
      });
    });

    renderLibrary();
  }

  /* Leaving the Record tab releases the camera so the phone's light goes out. */
  function onViewChange(view) {
    if (view === 'record') renderLibrary();
    else if (stream) stopCamera();
  }

  function count() {
    return allClips().then(function (r) { return r.length; }).catch(function () { return 0; });
  }

  function clearAll() {
    if (stream) stopCamera();
    return clearClips().then(function () { return renderLibrary(); }).catch(function () {});
  }

  /* Attach a saved clip to a logged training session, or detach with null. */
  function setSession(clipId, sessionId) {
    return getClip(clipId).then(function (c) {
      if (!c) return null;
      c.sessionId = sessionId || null;
      return putClip(c).then(function () { renderLibrary(); return c; });
    });
  }

  /* { sessionId: clipCount } for decorating the session log. */
  function countsBySession() {
    return allClips().then(function (rows) {
      var map = {};
      rows.forEach(function (c) {
        if (c.sessionId) map[c.sessionId] = (map[c.sessionId] || 0) + 1;
      });
      return map;
    }).catch(function () { return {}; });
  }

  /* Sessions can be deleted while their clips remain; keep the clips, drop the link. */
  function unlinkSession(sessionId) {
    return allClips().then(function (rows) {
      var orphans = rows.filter(function (c) { return c.sessionId === sessionId; });
      return Promise.all(orphans.map(function (c) {
        c.sessionId = null;
        return putClip(c);
      }));
    }).then(function () { return renderLibrary(); }).catch(function () {});
  }

  /* Analysis results ride along on the clip record. */
  function saveShots(clipId, shots) {
    return getClip(clipId).then(function (c) {
      if (!c) return null;
      c.shots = shots;
      c.analysedAt = new Date().toISOString();
      return putClip(c).then(function () { renderLibrary(); return c; });
    });
  }

  var api = {
    get: getClip,
    saveShots: saveShots,
    init: init,
    onViewChange: onViewChange,
    count: count,
    clearAll: clearAll,
    refresh: renderLibrary,
    setSession: setSession,
    countsBySession: countsBySession,
    unlinkSession: unlinkSession,
    onClipSaved: null,
    onAnalyse: null
  };

  return api;
})();
