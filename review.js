/* ============================================================
   Baseline CourtLog — shot review
   Drives the breakdown screen: runs the analysis over a clip,
   then lets you watch it back, call each shot in or out, and
   fix any label the model got wrong.
   ============================================================ */

window.CourtLogReview = (function () {
  'use strict';

  var A = window.CourtLogAnalysis;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clock(ms) {
    var t = Math.floor(ms / 1000);
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }

  function pct(v) { return v == null ? '—' : Math.round(v) + '%'; }

  var clip = null;
  var shots = [];
  var videoUrl = null;
  var running = false;

  /* ---------- entry point ---------- */

  function open(clipId, goTo) {
    if (!window.CourtLogClips) return;

    window.CourtLogClips.get(clipId).then(function (c) {
      if (!c) return;
      clip = c;
      shots = c.shots || [];

      goTo('shots');
      mountVideo(c);

      if (shots.length || c.analysedAt) {
        showResults();
        return;
      }
      runAnalysis(c);
    });
  }

  function mountVideo(c) {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(c.blob);
    var v = $('shotsVideo');
    v.src = videoUrl;
    $('shotsPlayerCard').hidden = false;
  }

  function unmount() {
    var v = $('shotsVideo');
    if (v) {
      v.pause();
      v.removeAttribute('src');
      try { v.load(); } catch (e) { /* ignore */ }
    }
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
  }

  /* ---------- running the model ---------- */

  function runAnalysis(c) {
    running = true;
    $('analysisCard').hidden = false;
    $('shotsSummary').hidden = true;
    $('shotsListCard').hidden = true;
    $('shotsActions').hidden = true;
    setProgress(0, 'Getting started');

    A.analyzeClip(c.blob, function (p) {
      /* the model download is the first slice of the bar, frames the rest */
      var overall = p.phase === 'model' ? p.pct * 0.15 : 0.15 + p.pct * 0.85;
      setProgress(overall, p.note);
    }).then(function (result) {
      running = false;
      shots = result.shots;

      if (result.warning) {
        $('shotsSub').textContent = result.warning;
      } else {
        $('shotsSub').textContent = 'Found ' + shots.length + ' shot' +
          (shots.length === 1 ? '' : 's') + '. Watch it back and call each one.';
      }

      return window.CourtLogClips.saveShots(c.id, shots);
    }).then(function () {
      showResults();
    }).catch(function (err) {
      running = false;
      $('anNote').textContent = 'Analysis failed';
      $('anHint').textContent = (err && err.message) ||
        'Something went wrong reading the clip.';
      $('anBar').style.width = '0%';
    });
  }

  function setProgress(fraction, note) {
    $('anBar').style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
    if (note) $('anNote').textContent = note;
  }

  /* ---------- results ---------- */

  function showResults() {
    $('analysisCard').hidden = true;
    $('shotsSummary').hidden = false;
    $('shotsListCard').hidden = false;
    $('shotsActions').hidden = false;
    renderSummary();
    renderList();
  }

  function renderSummary() {
    var s = A.summarise(shots);

    $('sumOverall').textContent = pct(s.overallPct);
    $('sumServe').textContent = s.serveCount ? pct(s.servePct) : 'none';

    $('sumUnmarked').textContent = s.unmarked
      ? s.unmarked + ' of ' + s.total + ' shots still need a call. Percentages only count the ones you have marked.'
      : (s.total ? 'Every shot is marked.' : 'No shots detected in this clip.');

    var table = $('shotTable');
    table.textContent = '';

    s.rows.forEach(function (r) {
      var row = el('div', 'report-row shot-row');

      var badge = el('div', 'shot-count', String(r.total));
      row.appendChild(badge);

      var body = el('div', 'report-body');
      body.appendChild(el('div', 'report-name', r.name));
      var bar = el('div', 'report-bar');
      var fill = el('div', 'report-fill inout');
      fill.style.width = (r.pct == null ? 0 : r.pct) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
      row.appendChild(body);

      row.appendChild(el('div', 'report-score',
        r.called ? pct(r.pct) + ' in' : 'no calls'));
      table.appendChild(row);
    });

    if (!s.rows.length) {
      table.appendChild(el('p', 'hint', 'Nothing to break down yet.'));
    }
  }

  function renderList() {
    var host = $('shotList');
    host.textContent = '';
    $('shotsCount').textContent = shots.length;

    if (!shots.length) {
      var li0 = el('li');
      li0.appendChild(el('div', 'empty',
        'No swings were detected. Pose analysis needs one player, side on, fully in frame.'));
      host.appendChild(li0);
      return;
    }

    shots.forEach(function (shot) {
      host.appendChild(shotRow(shot));
    });
  }

  function shotRow(shot) {
    var li = el('li', 'shot');

    var jump = el('button', 'shot-time', clock(shot.at));
    jump.type = 'button';
    jump.setAttribute('aria-label', 'Play from ' + clock(shot.at));
    jump.addEventListener('click', function () {
      var v = $('shotsVideo');
      v.currentTime = Math.max(0, (shot.at - 1500) / 1000);
      v.play().catch(function () {});
      $('shotsPlayerCard').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    li.appendChild(jump);

    var select = el('select', 'shot-type');
    select.setAttribute('aria-label', 'Shot type at ' + clock(shot.at));
    A.SHOTS.forEach(function (s) {
      var o = el('option', null, s.short);
      o.value = s.key;
      if (s.key === shot.key) o.selected = true;
      select.appendChild(o);
    });
    li.appendChild(select);

    var flag = shot.corrected
      ? el('span', 'shot-fixed', 'fixed')
      : (shot.confidence < 0.7 ? el('span', 'shot-unsure', 'unsure') : el('span', 'shot-flag'));
    li.appendChild(flag);

    select.addEventListener('change', function () {
      var newKey = select.value;
      if (newKey === shot.key) return;
      A.learnFrom(shot, newKey);
      shot.key = newKey;
      shot.corrected = true;
      flag.className = 'shot-fixed';
      flag.textContent = 'fixed';
      persist();
      renderSummary();
      toast('Relabelled. The model will lean this way next time.');
    });

    var calls = el('div', 'shot-call');
    [['in', 'In'], ['out', 'Out']].forEach(function (pair) {
      var b = el('button', 'callmini call-' + pair[0], pair[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', shot.call === pair[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        shot.call = (shot.call === pair[0]) ? null : pair[0];
        persist();
        renderSummary();
        var siblings = calls.querySelectorAll('.callmini');
        for (var i = 0; i < siblings.length; i++) {
          var key = siblings[i].classList.contains('call-in') ? 'in' : 'out';
          siblings[i].setAttribute('aria-pressed', shot.call === key ? 'true' : 'false');
        }
      });
      calls.appendChild(b);
    });
    li.appendChild(calls);

    return li;
  }

  var saveTimer = null;
  function persist() {
    if (!clip) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      window.CourtLogClips.saveShots(clip.id, shots);
    }, 400);
  }

  function toast(msg) { if (window.CourtLogToast) window.CourtLogToast(msg); }

  /* ---------- routing hooks ---------- */

  function onViewChange(view) {
    if (view !== 'shots') {
      unmount();
      if (running) { A.cancel(); running = false; }
    }
  }

  function init(goTo) {
    $('anCancel').addEventListener('click', function () {
      A.cancel();
      running = false;
      goTo('record');
    });
    $('shotsDone').addEventListener('click', function () {
      if (clip) window.CourtLogClips.saveShots(clip.id, shots);
      goTo('progress');
    });
  }

  return { init: init, open: open, onViewChange: onViewChange };
})();
