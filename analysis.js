/* ============================================================
   Baseline CourtLog — shot analysis
   Runs a pose model over a recorded clip, finds each swing, and
   classifies it into one of seven shots. Everything happens on
   this device; no frame ever leaves the phone.

   What the model can see: your joints. Not the racket, not the
   racket face, not the ball. That is why flat and topspin are
   reported together as a drive — the difference between them is
   racket face angle, which pose estimation cannot observe.
   ============================================================ */

window.CourtLogAnalysis = (function () {
  'use strict';

  /* ---------- shot vocabulary ---------- */

  var SHOTS = [
    { key: 'fh_drive', name: 'Forehand drive', short: 'FH drive' },
    { key: 'fh_slice', name: 'Forehand slice', short: 'FH slice' },
    { key: 'fh_volley', name: 'Forehand volley', short: 'FH volley' },
    { key: 'bh_drive', name: 'Backhand drive', short: 'BH drive' },
    { key: 'bh_slice', name: 'Backhand slice', short: 'BH slice' },
    { key: 'bh_volley', name: 'Backhand volley', short: 'BH volley' },
    { key: 'serve',    name: 'Serve',          short: 'Serve' }
  ];

  var SHOT_BY_KEY = {};
  SHOTS.forEach(function (s) { SHOT_BY_KEY[s.key] = s; });

  /* ---------- tunable thresholds, nudged by your corrections ---------- */

  var CAL_KEY = 'baseline-courtlog:calibration';

  var DEFAULTS = {
    hand: 'right',
    sideFlip: false,        // set when corrections say our forehand side is backwards
    sideVotes: 0,           // how many corrections have complained about the sides
    serveWristAboveNose: 0.15,   // wrist this far above the nose, in shoulder-widths
    serveExtension: 1.45,        // wrist-to-shoulder distance in shoulder-widths
    volleySpan: 1.30,            // total wrist path over the swing, in shoulder-widths
    volleyDuration: 420,         // milliseconds above the motion threshold
    sliceDrop: -0.10             // negative vertical path means high-to-low
  };

  function loadCal() {
    var cal = {};
    Object.keys(DEFAULTS).forEach(function (k) { cal[k] = DEFAULTS[k]; });
    try {
      var raw = localStorage.getItem(CAL_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(DEFAULTS).forEach(function (k) {
          if (saved[k] !== undefined && saved[k] !== null) cal[k] = saved[k];
        });
      }
    } catch (e) { /* defaults are fine */ }
    return cal;
  }

  function saveCal(cal) {
    try { localStorage.setItem(CAL_KEY, JSON.stringify(cal)); } catch (e) { /* ignore */ }
  }

  /* ---------- pose model ---------- */

  var TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
  var POSE = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js';

  var detector = null;
  var loading = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-src="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded) resolve();
        else {
          existing.addEventListener('load', function () { resolve(); });
          existing.addEventListener('error', function () { reject(new Error('load failed')); });
        }
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.dataset.src = src;
      s.onload = function () { s.dataset.loaded = '1'; resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureModel(onProgress) {
    if (detector) return Promise.resolve(detector);
    if (loading) return loading;

    loading = (function () {
      if (onProgress) onProgress({ phase: 'model', pct: 0, note: 'Downloading the pose model' });
      return loadScript(TFJS)
        .then(function () { return loadScript(POSE); })
        .then(function () {
          if (!window.tf || !window.poseDetection) {
            throw new Error('The pose library did not load.');
          }
          return window.tf.setBackend('webgl').catch(function () {
            return window.tf.setBackend('cpu');
          });
        })
        .then(function () { return window.tf.ready(); })
        .then(function () {
          return window.poseDetection.createDetector(
            window.poseDetection.SupportedModels.MoveNet,
            { modelType: window.poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
          );
        })
        .then(function (d) {
          detector = d;
          if (onProgress) onProgress({ phase: 'model', pct: 1, note: 'Pose model ready' });
          return d;
        })
        .catch(function (err) {
          loading = null;
          throw err;
        });
    })();

    return loading;
  }

  /* ---------- geometry helpers ---------- */

  function kp(pose, name) {
    if (!pose || !pose.keypoints) return null;
    for (var i = 0; i < pose.keypoints.length; i++) {
      if (pose.keypoints[i].name === name) {
        var k = pose.keypoints[i];
        return (k.score == null || k.score > 0.3) ? k : null;
      }
    }
    return null;
  }

  function dist(a, b) {
    if (!a || !b) return 0;
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* One frame reduced to the handful of measurements the classifier needs.
     Everything is in shoulder-widths so it does not matter how close you
     are to the camera. */
  function frameMetrics(pose, hand) {
    var ls = kp(pose, 'left_shoulder'), rs = kp(pose, 'right_shoulder');
    if (!ls || !rs) return null;

    var unit = dist(ls, rs);
    if (unit < 8) return null;   // player too small in frame to measure reliably

    var domWrist = kp(pose, hand === 'left' ? 'left_wrist' : 'right_wrist');
    var offWrist = kp(pose, hand === 'left' ? 'right_wrist' : 'left_wrist');
    var domElbow = kp(pose, hand === 'left' ? 'left_elbow' : 'right_elbow');
    var domShoulder = hand === 'left' ? ls : rs;
    if (!domWrist) return null;

    var nose = kp(pose, 'nose');
    var lh = kp(pose, 'left_hip'), rh = kp(pose, 'right_hip');
    var centreX = (lh && rh) ? (lh.x + rh.x) / 2 : (ls.x + rs.x) / 2;

    return {
      unit: unit,
      wx: domWrist.x, wy: domWrist.y,
      ex: domElbow ? domElbow.x : domWrist.x,
      ey: domElbow ? domElbow.y : domWrist.y,
      sx: domShoulder.x, sy: domShoulder.y,
      centreX: centreX,
      /* y grows downward, so "above the nose" is a negative offset */
      wristAboveNose: nose ? (nose.y - domWrist.y) / unit : 0,
      extension: dist(domWrist, domShoulder) / unit,
      lateral: (domWrist.x - centreX) / unit,
      handsTogether: offWrist ? (dist(domWrist, offWrist) / unit) : 99
    };
  }

  /* ---------- sampling the clip ---------- */

  var SAMPLE_MS = 50;      // 20 samples a second is enough to catch a swing
  var MAX_FRAMES = 2400;   // hard ceiling so a long clip cannot run forever

  function sampleClip(blob, onProgress) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d', { willReadFrequently: true });

      var frames = [];
      var times = [];
      var duration = 0;
      var t = 0;
      var cancelled = false;

      function cleanup() {
        URL.revokeObjectURL(url);
        video.removeAttribute('src');
        try { video.load(); } catch (e) { /* ignore */ }
      }

      video.onerror = function () {
        cleanup();
        reject(new Error('That clip could not be decoded for analysis.'));
      };

      video.onloadedmetadata = function () {
        duration = video.duration;
        if (!isFinite(duration) || duration <= 0) {
          cleanup();
          reject(new Error('That clip has no readable duration.'));
          return;
        }
        var w = video.videoWidth || 640;
        var h = video.videoHeight || 480;
        var scale = Math.min(1, 480 / Math.max(w, h));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        step();
      };

      function step() {
        if (cancelled) { cleanup(); reject(new Error('Analysis cancelled.')); return; }
        if (t > duration || frames.length >= MAX_FRAMES) { finish(); return; }
        video.currentTime = t;
      }

      video.onseeked = function () {
        if (cancelled) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        detector.estimatePoses(canvas, { maxPoses: 1, flipHorizontal: false })
          .then(function (poses) {
            frames.push(poses && poses[0] ? poses[0] : null);
            times.push(t * 1000);
            if (onProgress) {
              onProgress({
                phase: 'frames',
                pct: Math.min(1, t / duration),
                note: 'Reading your movement'
              });
            }
            t += SAMPLE_MS / 1000;
            /* yield to the browser so the progress bar actually paints */
            setTimeout(step, 0);
          })
          .catch(function () {
            frames.push(null);
            times.push(t * 1000);
            t += SAMPLE_MS / 1000;
            setTimeout(step, 0);
          });
      };

      function finish() {
        cleanup();
        resolve({ frames: frames, times: times, durationMs: duration * 1000 });
      }

      this_cancel = function () { cancelled = true; };
    });
  }

  var this_cancel = null;

  /* ---------- finding the swings ---------- */

  /* A swing shows up as a burst of joint speed. Weighting the wrist most
     heavily and adding elbow and shoulder follows the approach used in
     published tennis pose pipelines. */
  function motionTrace(metrics, times) {
    var speed = new Array(metrics.length).fill(0);
    for (var i = 1; i < metrics.length; i++) {
      var a = metrics[i - 1], b = metrics[i];
      if (!a || !b) continue;
      var dt = Math.max(1, times[i] - times[i - 1]) / 1000;
      var wrist = Math.hypot(b.wx - a.wx, b.wy - a.wy) / b.unit / dt;
      var elbow = Math.hypot(b.ex - a.ex, b.ey - a.ey) / b.unit / dt;
      var shoulder = Math.hypot(b.sx - a.sx, b.sy - a.sy) / b.unit / dt;
      speed[i] = 0.60 * wrist + 0.25 * elbow + 0.15 * shoulder;
    }
    /* light smoothing kills single-frame keypoint jitter */
    var out = speed.slice();
    for (var j = 1; j < speed.length - 1; j++) {
      out[j] = (speed[j - 1] + 2 * speed[j] + speed[j + 1]) / 4;
    }
    return out;
  }

  function findPeaks(speed, times) {
    var valid = speed.filter(function (v) { return v > 0; });
    if (valid.length < 8) return [];

    var sorted = valid.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    var high = sorted[Math.floor(sorted.length * 0.9)];
    /* a swing has to stand out from ordinary movement around the court */
    var threshold = Math.max(median * 2.2, high * 0.55, 1.4);

    var peaks = [];
    var lastPeakTime = -1e9;
    for (var i = 2; i < speed.length - 2; i++) {
      var v = speed[i];
      if (v < threshold) continue;
      if (v < speed[i - 1] || v < speed[i + 1]) continue;
      if (times[i] - lastPeakTime < 600) {   // one swing, one peak
        if (peaks.length && v > peaks[peaks.length - 1].v) {
          peaks[peaks.length - 1] = { i: i, v: v };
          lastPeakTime = times[i];
        }
        continue;
      }
      peaks.push({ i: i, v: v });
      lastPeakTime = times[i];
    }
    return peaks;
  }

  /* ---------- classifying one swing ---------- */

  function describeSwing(peak, metrics, times, speed, cal) {
    var i = peak.i;
    var at = times[i];

    function nearest(targetMs) {
      var best = -1, bestD = 1e9;
      for (var k = 0; k < times.length; k++) {
        if (!metrics[k]) continue;
        var d = Math.abs(times[k] - targetMs);
        if (d < bestD) { bestD = d; best = k; }
      }
      return best >= 0 ? metrics[best] : null;
    }

    var atContact = metrics[i] || nearest(at);
    var before = nearest(at - 150);
    var after = nearest(at + 150);
    if (!atContact) return null;

    /* how far the wrist travelled through the whole swing window */
    var span = 0;
    for (var k = 1; k < metrics.length; k++) {
      if (times[k] < at - 400 || times[k] > at + 400) continue;
      var a = metrics[k - 1], b = metrics[k];
      if (!a || !b) continue;
      span += Math.hypot(b.wx - a.wx, b.wy - a.wy) / b.unit;
    }

    /* how long the motion stayed energetic around this peak */
    var half = peak.v * 0.4;
    var startI = i, endI = i;
    while (startI > 0 && speed[startI] > half) startI--;
    while (endI < speed.length - 1 && speed[endI] > half) endI++;
    var duration = times[endI] - times[startI];

    /* positive means the wrist rose through contact, negative means it dropped */
    var verticalPath = (before && after) ? (before.wy - after.wy) / atContact.unit : 0;

    var feat = {
      at: Math.round(at),
      span: span,
      duration: duration,
      verticalPath: verticalPath,
      lateral: atContact.lateral,
      extension: atContact.extension,
      wristAboveNose: atContact.wristAboveNose,
      handsTogether: atContact.handsTogether,
      peak: peak.v
    };

    return feat;
  }

  function classify(feat, cal, forehandSign) {
    var conf = 0.6;
    var key;

    if (feat.wristAboveNose > cal.serveWristAboveNose && feat.extension > cal.serveExtension) {
      key = 'serve';
      conf = 0.85;
    } else {
      var isForehand = (feat.lateral * forehandSign) > 0;
      var prefix = isForehand ? 'fh' : 'bh';
      /* a two-handed backhand puts both wrists together, a strong extra signal */
      if (feat.handsTogether < 0.45) { prefix = 'bh'; conf += 0.1; }

      if (feat.span < cal.volleySpan && feat.duration < cal.volleyDuration) {
        key = prefix + '_volley';
        conf = 0.7;
      } else if (feat.verticalPath < cal.sliceDrop) {
        key = prefix + '_slice';
        conf = 0.7;
      } else {
        key = prefix + '_drive';
        conf = 0.65;
      }
    }

    return { key: key, confidence: Math.min(0.95, conf) };
  }

  /* ---------- the whole pipeline ---------- */

  function analyzeClip(blob, onProgress) {
    var cal = loadCal();

    return ensureModel(onProgress).then(function () {
      return sampleClip(blob, onProgress);
    }).then(function (sampled) {
      if (onProgress) onProgress({ phase: 'classify', pct: 0.9, note: 'Working out the shots' });

      var metrics = sampled.frames.map(function (p) { return frameMetrics(p, cal.hand); });
      var seen = metrics.filter(Boolean).length;

      if (seen < 10) {
        return {
          shots: [],
          framesWithPose: seen,
          totalFrames: metrics.length,
          warning: 'I could not find a player in this clip. Prop the phone side-on so your whole body stays in frame, and keep one player in shot.'
        };
      }

      var speed = motionTrace(metrics, sampled.times);
      var peaks = findPeaks(speed, sampled.times);

      var feats = peaks.map(function (p) {
        return describeSwing(p, metrics, sampled.times, speed, cal);
      }).filter(Boolean);

      /* Whether a positive sideways offset means forehand depends on which
         way you face the camera. Most players hit more forehands than
         backhands, so take the bigger cluster as the forehand side. A
         correction flips it permanently. */
      var pos = feats.filter(function (f) { return f.lateral > 0; }).length;
      var neg = feats.length - pos;
      var forehandSign = (pos >= neg ? 1 : -1) * (cal.sideFlip ? -1 : 1);

      var shots = feats.map(function (f, idx) {
        var c = classify(f, cal, forehandSign);
        return {
          id: 'sh_' + idx + '_' + Math.round(f.at),
          at: f.at,
          key: c.key,
          confidence: c.confidence,
          call: null,          // 'in' | 'out', set by you during review
          corrected: false,
          features: f
        };
      });

      if (onProgress) onProgress({ phase: 'done', pct: 1, note: 'Done' });

      return {
        shots: shots,
        framesWithPose: seen,
        totalFrames: metrics.length,
        forehandSign: forehandSign,
        warning: shots.length ? null :
          'No swings stood out in this clip. Analysis needs you clearly in frame with a full swing motion.'
      };
    });
  }

  function cancel() { if (this_cancel) this_cancel(); }

  /* ---------- learning from your corrections ---------- */

  /* Bounds keep one stray correction from wrecking the classifier. A
     threshold moves a quarter of the way toward the shot that disagreed
     with it, and never leaves the range where it still means something. */
  var LIMITS = {
    serveWristAboveNose: [-0.20, 0.80],
    serveExtension:      [0.90, 2.00],
    volleySpan:          [0.60, 3.00],
    volleyDuration:      [200, 900],
    sliceDrop:           [-0.50, -0.02]
  };

  var LEARN_RATE = 0.25;

  function nudge(cal, field, target) {
    var lo = LIMITS[field][0], hi = LIMITS[field][1];
    var next = cal[field] + (target - cal[field]) * LEARN_RATE;
    cal[field] = Math.max(lo, Math.min(hi, next));
  }

  /* Each correction pulls the boundary that got it wrong toward your
     strokes, so the model drifts to fit you rather than a generic player. */
  function learnFrom(shot, newKey) {
    var cal = loadCal();
    var f = shot.features;
    if (!f) return cal;

    var wasServe = shot.key === 'serve';
    var nowServe = newKey === 'serve';

    if (wasServe && !nowServe) {
      /* it was not a serve, so the bar for calling one is too low */
      nudge(cal, 'serveWristAboveNose', f.wristAboveNose + 0.10);
      nudge(cal, 'serveExtension', f.extension + 0.08);
    } else if (!wasServe && nowServe) {
      nudge(cal, 'serveWristAboveNose', f.wristAboveNose - 0.05);
      nudge(cal, 'serveExtension', f.extension - 0.05);
    }

    var wasVolley = /_volley$/.test(shot.key);
    var nowVolley = /_volley$/.test(newKey);
    if (wasVolley && !nowVolley) {
      nudge(cal, 'volleySpan', f.span - 0.10);
      nudge(cal, 'volleyDuration', f.duration - 40);
    } else if (!wasVolley && nowVolley) {
      nudge(cal, 'volleySpan', f.span + 0.10);
      nudge(cal, 'volleyDuration', f.duration + 40);
    }

    var wasSlice = /_slice$/.test(shot.key);
    var nowSlice = /_slice$/.test(newKey);
    if (wasSlice && !nowSlice) {
      nudge(cal, 'sliceDrop', f.verticalPath - 0.05);
    } else if (!wasSlice && nowSlice) {
      nudge(cal, 'sliceDrop', f.verticalPath + 0.05);
    }

    /* Forehand called a backhand means our sides may be mirrored, but one
       correction is not proof. Flip only once the same complaint repeats. */
    var wasFh = /^fh_/.test(shot.key), nowFh = /^fh_/.test(newKey);
    if (wasFh !== nowFh && !wasServe && !nowServe) {
      cal.sideVotes = (cal.sideVotes || 0) + 1;
      if (cal.sideVotes >= 2) {
        cal.sideFlip = !cal.sideFlip;
        cal.sideVotes = 0;
      }
    }

    saveCal(cal);
    return cal;
  }

  /* ---------- turning shots into the numbers you asked for ---------- */

  function summarise(shots) {
    var rows = SHOTS.map(function (s) {
      var mine = shots.filter(function (x) { return x.key === s.key; });
      var called = mine.filter(function (x) { return x.call; });
      var inCount = called.filter(function (x) { return x.call === 'in'; }).length;
      return {
        key: s.key,
        name: s.name,
        short: s.short,
        total: mine.length,
        called: called.length,
        in: inCount,
        out: called.length - inCount,
        pct: called.length ? (inCount / called.length) * 100 : null
      };
    });

    var allCalled = shots.filter(function (x) { return x.call; });
    var allIn = allCalled.filter(function (x) { return x.call === 'in'; }).length;

    var serveRow = rows.filter(function (r) { return r.key === 'serve'; })[0];
    var rallyCalled = allCalled.filter(function (x) { return x.key !== 'serve'; });
    var rallyIn = rallyCalled.filter(function (x) { return x.call === 'in'; }).length;

    return {
      rows: rows.filter(function (r) { return r.total > 0; }),
      allRows: rows,
      total: shots.length,
      called: allCalled.length,
      unmarked: shots.length - allCalled.length,
      overallPct: allCalled.length ? (allIn / allCalled.length) * 100 : null,
      rallyPct: rallyCalled.length ? (rallyIn / rallyCalled.length) * 100 : null,
      servePct: serveRow && serveRow.called ? serveRow.pct : null,
      serveCount: serveRow ? serveRow.total : 0
    };
  }

  return {
    SHOTS: SHOTS,
    SHOT_BY_KEY: SHOT_BY_KEY,
    analyzeClip: analyzeClip,
    cancel: cancel,
    summarise: summarise,
    learnFrom: learnFrom,
    loadCal: loadCal,
    saveCal: saveCal
  };
})();
