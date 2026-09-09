/* ============================================================
   Baseline CourtLog
   A client-side tennis training tracker. Every session lives in
   this device's localStorage. Nothing is uploaded anywhere, so a
   fresh install always starts a fresh career.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- constants ---------- */

  /* Bump on every change that ships. Shown on the dashboard so a bug report
     can say which build it came from. */
  var BUILD = 'build 7 · 8 Sep 2026';

  var STORE_KEY = 'baseline-courtlog:v1';
  var THEME_KEY = 'baseline-courtlog:theme';

  var MECHANICS = [
    { key: 'forehand', name: 'Forehands', desc: 'Depth, spin, recovery' },
    { key: 'backhand', name: 'Backhands', desc: 'Balance, contact point' },
    { key: 'volleys',  name: 'Volleys',   desc: 'Hands, footwork, punch' },
    { key: 'serves',   name: 'Serves',    desc: 'Toss, rhythm, placement' }
  ];

  var LETTERS = ['A', 'B', 'C', 'D', 'F'];
  var POINTS = { A: 4, B: 3, C: 2, D: 1, F: 0 };

  var DAY = 86400000;
  var HALF_LIFE_DAYS = 120;   // older sessions fade out of the grade
  var HOURS_SCALE = 400;      // court hours needed to saturate the volume factor
  var BALLS_SCALE = 120000;   // balls needed to saturate the volume factor
  var ODDS_CEILING = 94;      // the model never promises a certainty

  var nf = new Intl.NumberFormat();

  /* ---------- tiny DOM helpers ---------- */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- storage ---------- */

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.sessions)) return [];
      return data.sessions.filter(validSession);
    } catch (e) {
      return [];
    }
  }

  function save(sessions) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, sessions: sessions }));
      return true;
    } catch (e) {
      toast('Could not save. Storage may be full or blocked.');
      return false;
    }
  }

  function validSession(s) {
    if (!s || typeof s !== 'object') return false;
    if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return false;
    if (!isFinite(s.minutes) || !isFinite(s.balls)) return false;
    if (!s.grades) return false;
    for (var i = 0; i < MECHANICS.length; i++) {
      if (LETTERS.indexOf(s.grades[MECHANICS[i].key]) === -1) return false;
    }
    return true;
  }

  var sessions = load();

  /* ---------- dates ---------- */

  function parseDate(iso) {
    var p = iso.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function startOfToday() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function daysAgo(iso) {
    return Math.max(0, (startOfToday() - parseDate(iso).getTime()) / DAY);
  }

  function prettyDate(iso) {
    var d = parseDate(iso);
    var diff = Math.round(daysAgo(iso));
    var base = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 0) return base + ' (upcoming)';
    return base + (d.getFullYear() !== new Date().getFullYear() ? ', ' + d.getFullYear() : '');
  }

  /* Only the relative words read naturally in mid-sentence lower case. */
  function softDate(iso) {
    var s = prettyDate(iso);
    return (s === "Today" || s === "Yesterday") ? s.toLowerCase() : s;
  }

  function prettyDuration(mins) {
    var h = Math.floor(mins / 60);
    var m = Math.round(mins % 60);
    if (h && m) return h + 'h ' + m + 'm';
    if (h) return h + 'h';
    return m + 'm';
  }

  /* ---------- the maths ---------- */

  function letterFor(points) {
    if (points >= 3.5) return 'A';
    if (points >= 2.5) return 'B';
    if (points >= 1.5) return 'C';
    if (points >= 0.5) return 'D';
    return 'F';
  }

  /* Weight a session by how much work it was and how recent it is. */
  function weightOf(s) {
    var hours = Math.max(s.minutes / 60, 0.25);
    var recency = Math.pow(0.5, daysAgo(s.date) / HALF_LIFE_DAYS);
    return hours * Math.max(recency, 0.02);
  }

  function computeStats() {
    var st = {
      count: sessions.length,
      balls: 0,
      minutes: 0,
      hours: 0,
      perMechanic: {},
      overallPoints: 0,
      overallLetter: '-',
      firstDate: null,
      lastDate: null
    };

    MECHANICS.forEach(function (m) {
      st.perMechanic[m.key] = { points: 0, letter: '-', pct: 0 };
    });

    if (!sessions.length) return st;

    var totals = {}, weights = {};
    MECHANICS.forEach(function (m) { totals[m.key] = 0; weights[m.key] = 0; });

    sessions.forEach(function (s) {
      st.balls += s.balls;
      st.minutes += s.minutes;
      var w = weightOf(s);
      MECHANICS.forEach(function (m) {
        totals[m.key] += POINTS[s.grades[m.key]] * w;
        weights[m.key] += w;
      });
    });

    st.hours = st.minutes / 60;

    var sum = 0;
    MECHANICS.forEach(function (m) {
      var p = weights[m.key] > 0 ? totals[m.key] / weights[m.key] : 0;
      st.perMechanic[m.key] = { points: p, letter: letterFor(p), pct: (p / 4) * 100 };
      sum += p;
    });

    st.overallPoints = sum / MECHANICS.length;
    st.overallLetter = letterFor(st.overallPoints);

    var sorted = sessions.map(function (s) { return s.date; }).sort();
    st.firstDate = sorted[0];
    st.lastDate = sorted[sorted.length - 1];

    return st;
  }

  /* Balanced model: near zero at the start, climbs with hours, ball
     volume, grades and consistency, and always stops short of certain. */
  function computeOdds(st) {
    if (!st.count) {
      return {
        pct: 0,
        caption: 'Not started',
        factors: [
          { name: 'Technique grade', pct: 0, note: 'Log a session to set your baseline.' },
          { name: 'Court hours',     pct: 0, note: '0 of ' + HOURS_SCALE + ' reference hours.' },
          { name: 'Ball volume',     pct: 0, note: '0 of ' + nf.format(BALLS_SCALE) + ' reference balls.' },
          { name: 'Consistency',     pct: 0, note: 'No sessions in the last four weeks.' }
        ]
      };
    }

    var skill = st.overallPoints / 4;
    var volume = 1 - Math.exp(-st.hours / HOURS_SCALE);
    var ballVol = 1 - Math.exp(-st.balls / BALLS_SCALE);

    var cutoff = startOfToday() - 28 * DAY;
    var recent = sessions.filter(function (s) { return parseDate(s.date).getTime() >= cutoff; }).length;

    var weekKeys = {};
    sessions.forEach(function (s) {
      weekKeys[Math.floor(parseDate(s.date).getTime() / (7 * DAY))] = true;
    });
    var activeWeeks = Object.keys(weekKeys).length;

    var consistency = 0.6 * Math.min(recent / 12, 1) + 0.4 * Math.min(activeWeeks / 26, 1);

    var base = 0.45 * volume + 0.35 * ballVol + 0.20 * consistency;
    var pct = ODDS_CEILING * Math.pow(skill, 1.8) * base;
    pct = Math.max(0, Math.min(ODDS_CEILING, pct));

    return {
      pct: pct,
      caption: captionFor(pct),
      factors: [
        {
          name: 'Technique grade',
          pct: skill * 100,
          note: 'Overall ' + st.overallLetter + ' at ' + st.overallPoints.toFixed(2) + ' of 4.00.'
        },
        {
          name: 'Court hours',
          pct: volume * 100,
          note: st.hours.toFixed(1) + ' of ' + HOURS_SCALE + ' reference hours.'
        },
        {
          name: 'Ball volume',
          pct: ballVol * 100,
          note: nf.format(st.balls) + ' of ' + nf.format(BALLS_SCALE) + ' reference balls.'
        },
        {
          name: 'Consistency',
          pct: consistency * 100,
          note: recent + ' session' + (recent === 1 ? '' : 's') + ' in the last four weeks, ' +
                activeWeeks + ' active week' + (activeWeeks === 1 ? '' : 's') + ' all time.'
        }
      ]
    };
  }

  function captionFor(p) {
    if (p <= 0) return 'Not started';
    if (p < 0.5) return 'First steps';
    if (p < 2) return 'Building a base';
    if (p < 8) return 'Serious amateur';
    if (p < 20) return 'Regional contender';
    if (p < 40) return 'National potential';
    if (p < 65) return 'Tour trajectory';
    return 'Pro pathway';
  }

  function formatOdds(p) {
    if (p <= 0) return '0%';
    if (p < 1) return p.toFixed(2) + '%';
    return p.toFixed(1) + '%';
  }

  /* ---------- theme ---------- */

  var THEMES = ['system', 'light', 'dark'];
  var GLYPHS = { system: '◐', light: '☀', dark: '☽' };
  var LABELS = { system: 'Theme: match device', light: 'Theme: light', dark: 'Theme: dark' };

  function currentTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return THEMES.indexOf(t) === -1 ? 'system' : t;
    } catch (e) {
      return 'system';
    }
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeGlyph').textContent = GLYPHS[t];
    $('themeBtn').setAttribute('aria-label', LABELS[t] + '. Tap to change.');
    $('themeBtn').setAttribute('title', LABELS[t]);

    var dark = t === 'dark' ||
      (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var color = dark ? '#0d1512' : '#eef1ea';
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      metas[i].removeAttribute('media');
      metas[i].setAttribute('content', color);
    }
  }

  function cycleTheme() {
    var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    applyTheme(next);
    toast(LABELS[next].replace('Theme: ', 'Theme set to ') + '.');
  }

  /* ---------- routing ---------- */

  var VIEWS = ['dashboard', 'log', 'record', 'shots', 'progress'];
  var currentView = 'dashboard';

  /* Surface a broken screen instead of failing silently, so a bug report
     can say which part gave up. */
  function report(where, err) {
    if (window.console && console.error) console.error('[CourtLog] ' + where, err);
    toast('Something went wrong loading ' + where + '. The rest still works.');
  }

  function go(view) {
    if (VIEWS.indexOf(view) === -1) view = 'dashboard';
    currentView = view;

    /* Never let a missing section throw partway through and strand the user
       on whatever screen happened to be showing. */
    VIEWS.forEach(function (v) {
      var node = $('view-' + v);
      if (node) node.hidden = (v !== view);
    });

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].dataset.go === view) tabs[i].setAttribute('aria-current', 'page');
      else tabs[i].removeAttribute('aria-current');
    }

    /* A failure inside any one of these must not undo the navigation. */
    try { if (view === 'dashboard') renderDashboard(); } catch (e) { report('dashboard', e); }
    try { if (view === 'progress') renderProgress(); } catch (e) { report('progress', e); }
    try { if (window.CourtLogClips) window.CourtLogClips.onViewChange(view); } catch (e) { report('clips', e); }
    try { if (window.CourtLogReview) window.CourtLogReview.onViewChange(view); } catch (e) { report('review', e); }

    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* ---------- toast ---------- */

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------- grade picker ---------- */

  var draftGrades = {};

  function buildGradePicker() {
    var host = $('gradeGroups');
    host.textContent = '';

    MECHANICS.forEach(function (m) {
      var group = el('div', 'grade-group');

      var head = el('div', 'grade-head');
      head.appendChild(el('span', 'grade-name', m.name));
      head.appendChild(el('span', 'grade-desc', m.desc));
      group.appendChild(head);

      var row = el('div', 'grade-row');
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', m.name + ' grade');

      LETTERS.forEach(function (letter) {
        var b = el('button', 'grade-btn', letter);
        b.type = 'button';
        b.dataset.grade = letter;
        b.dataset.mech = m.key;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.addEventListener('click', function () { pickGrade(m.key, letter); });
        b.addEventListener('keydown', function (ev) { gradeKeys(ev, m.key, letter); });
        row.appendChild(b);
      });

      group.appendChild(row);
      host.appendChild(group);
    });
  }

  function pickGrade(mech, letter) {
    draftGrades[mech] = letter;
    var btns = document.querySelectorAll('.grade-btn[data-mech="' + mech + '"]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-checked', btns[i].dataset.grade === letter ? 'true' : 'false');
    }
  }

  function gradeKeys(ev, mech, letter) {
    var dir = 0;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') dir = 1;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') dir = -1;
    else return;
    ev.preventDefault();
    var i = (LETTERS.indexOf(letter) + dir + LETTERS.length) % LETTERS.length;
    var next = LETTERS[i];
    pickGrade(mech, next);
    document.querySelector('.grade-btn[data-mech="' + mech + '"][data-grade="' + next + '"]').focus();
  }

  function resetForm() {
    $('sessionForm').reset();
    $('fDate').value = todayISO();
    draftGrades = {};
    var btns = document.querySelectorAll('.grade-btn');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-checked', 'false');
    $('formError').hidden = true;
    var inv = document.querySelectorAll('.invalid');
    for (var j = 0; j < inv.length; j++) inv[j].classList.remove('invalid');
  }

  /* ---------- submit ---------- */

  function handleSubmit(ev) {
    ev.preventDefault();

    var errBox = $('formError');
    var problems = [];
    ['fDate', 'fMinutes', 'fBalls'].forEach(function (id) { $(id).classList.remove('invalid'); });

    var date = $('fDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      problems.push('pick a date');
      $('fDate').classList.add('invalid');
    }

    var minutes = parseInt($('fMinutes').value, 10);
    if (!isFinite(minutes) || minutes < 1 || minutes > 900) {
      problems.push('enter a training length between 1 and 900 minutes');
      $('fMinutes').classList.add('invalid');
    }

    var balls = parseInt($('fBalls').value, 10);
    if (!isFinite(balls) || balls < 0 || balls > 20000) {
      problems.push('enter a ball count between 0 and 20,000');
      $('fBalls').classList.add('invalid');
    }

    var missing = MECHANICS.filter(function (m) { return !draftGrades[m.key]; });
    if (missing.length) {
      problems.push('grade ' + missing.map(function (m) { return m.name.toLowerCase(); }).join(', '));
    }

    if (problems.length) {
      errBox.textContent = 'Before you submit, ' + problems.join('; ') + '.';
      errBox.hidden = false;
      errBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    var entry = {
      id: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      date: date,
      minutes: minutes,
      balls: balls,
      grades: {
        forehand: draftGrades.forehand,
        backhand: draftGrades.backhand,
        volleys: draftGrades.volleys,
        serves: draftGrades.serves
      },
      notes: $('fNotes').value.trim(),
      createdAt: new Date().toISOString()
    };

    sessions.push(entry);
    if (!save(sessions)) {
      sessions.pop();
      return;
    }

    resetForm();
    go('progress');

    if (pendingClipId && window.CourtLogClips) {
      var clipId = pendingClipId;
      pendingClipId = null;
      window.CourtLogClips.setSession(clipId, entry.id).then(function () {
        toast('Session logged and the clip is attached.');
        startReview(clipId);
      });
      return;
    }

    toast('Session logged. ' + nf.format(balls) + ' more balls in the bank.');
  }

  /* ---------- rendering: dashboard ---------- */

  function renderDashboard() {
    var st = computeStats();

    $('tSessions').textContent = nf.format(st.count);
    $('tBalls').textContent = nf.format(st.balls);
    $('tHours').textContent = st.hours >= 100 ? Math.round(st.hours) : st.hours.toFixed(1);
    $('tGrade').textContent = st.count ? st.overallLetter : '—';

    $('dashGreeting').textContent = st.count
      ? 'Overall ' + st.overallLetter + ' across ' + nf.format(st.count) + ' session' +
        (st.count === 1 ? '' : 's') + '. Last on court ' + softDate(st.lastDate) + '.'
      : 'No sessions yet. Log your first training to start the career.';

    var list = $('recentList');
    list.textContent = '';

    if (!st.count) {
      list.appendChild(emptyState('Your last few sessions will appear here.'));
      return;
    }

    byNewest(sessions).slice(0, 3).forEach(function (s) {
      list.appendChild(entryNode(s, false));
    });
  }

  function byNewest(arr) {
    return arr.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || '') < (a.createdAt || '') ? -1 : 1;
    });
  }

  function emptyState(msg) {
    var li = el('li');
    li.appendChild(el('div', 'empty', msg));
    return li;
  }

  function entryNode(s, withDelete) {
    var li = el('li', 'entry');

    var top = el('div', 'entry-top');
    top.appendChild(el('span', 'entry-date', prettyDate(s.date)));
    top.appendChild(el('span', 'entry-meta',
      prettyDuration(s.minutes) + ' · ' + nf.format(s.balls) + ' balls'));
    li.appendChild(top);

    var tags = el('div', 'entry-grades');
    MECHANICS.forEach(function (m) {
      var tag = el('span', 'gtag');
      tag.dataset.g = s.grades[m.key];
      tag.appendChild(document.createTextNode(m.name));
      tag.appendChild(el('b', null, s.grades[m.key]));
      tags.appendChild(tag);
    });
    li.appendChild(tags);

    if (s.notes) li.appendChild(el('p', 'entry-notes', s.notes));

    if (withDelete) {
      var del = el('button', 'entry-del', 'Delete this session');
      del.type = 'button';
      var armed = false;
      del.addEventListener('click', function () {
        if (!armed) {
          armed = true;
          del.textContent = 'Tap again to delete permanently';
          setTimeout(function () {
            armed = false;
            del.textContent = 'Delete this session';
          }, 4000);
          return;
        }
        sessions = sessions.filter(function (x) { return x.id !== s.id; });
        save(sessions);
        /* Keep the footage, just drop the link to a session that no longer exists. */
        if (window.CourtLogClips) window.CourtLogClips.unlinkSession(s.id);
        renderProgress();
        toast('Session deleted. Any clip stays in your library.');
      });
      li.appendChild(del);
    }

    return li;
  }

  /* ---------- rendering: progress ---------- */

  function renderProgress() {
    var st = computeStats();

    $('pBalls').textContent = nf.format(st.balls);
    $('pBallsSub').textContent = st.count
      ? 'Across ' + nf.format(st.count) + ' session' + (st.count === 1 ? '' : 's') +
        ' and ' + st.hours.toFixed(1) + ' hours on court, since ' + softDate(st.firstDate) + '.'
      : 'Across 0 sessions and 0 hours on court.';

    /* report card */
    var report = $('reportCard');
    report.textContent = '';
    MECHANICS.forEach(function (m) {
      var d = st.perMechanic[m.key];
      var has = st.count > 0;

      var row = el('div', 'report-row');

      var letter = el('div', 'report-letter', has ? d.letter : '—');
      letter.dataset.g = has ? d.letter : '-';
      row.appendChild(letter);

      var body = el('div', 'report-body');
      body.appendChild(el('div', 'report-name', m.name));
      var bar = el('div', 'report-bar');
      var fill = el('div', 'report-fill');
      fill.dataset.g = has ? d.letter : '-';
      fill.style.width = (has ? d.pct : 0) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
      row.appendChild(body);

      row.appendChild(el('div', 'report-score', has ? d.points.toFixed(2) + ' / 4.00' : 'no data'));
      report.appendChild(row);
    });

    /* odds */
    var odds = computeOdds(st);
    $('oddsValue').textContent = formatOdds(odds.pct);
    $('oddsCaption').textContent = odds.caption;

    var circumference = 2 * Math.PI * 52;
    $('dialFill').style.strokeDashoffset = circumference * (1 - Math.min(odds.pct, 100) / 100);

    var fl = $('oddsFactors');
    fl.textContent = '';
    odds.factors.forEach(function (f) {
      var li = el('li');
      var top = el('div', 'factor-top');
      top.appendChild(el('span', 'factor-name', f.name));
      top.appendChild(el('span', 'factor-pct', Math.round(f.pct) + '%'));
      li.appendChild(top);
      var bar = el('div', 'factor-bar');
      var fill = el('div', 'factor-fill');
      fill.style.width = Math.max(0, Math.min(100, f.pct)) + '%';
      bar.appendChild(fill);
      li.appendChild(bar);
      li.appendChild(el('p', 'factor-note', f.note));
      fl.appendChild(li);
    });

    /* log */
    $('logCount').textContent = nf.format(st.count);
    var list = $('logList');
    list.textContent = '';
    if (!st.count) {
      list.appendChild(emptyState('Nothing logged yet. Add a training session and it will show up here.'));
    } else {
      byNewest(sessions).forEach(function (s) {
        var node = entryNode(s, true);
        node.dataset.session = s.id;
        list.appendChild(node);
      });
      decorateWithClips();
    }
  }

  /* Clip counts arrive from IndexedDB, so they land a beat after the log renders. */
  function decorateWithClips() {
    if (!window.CourtLogClips) return;
    window.CourtLogClips.countsBySession().then(function (map) {
      Object.keys(map).forEach(function (sessionId) {
        var node = document.querySelector('.entry[data-session="' + sessionId + '"]');
        if (!node || node.querySelector('.entry-clips')) return;
        var n = map[sessionId];
        var tag = el('span', 'entry-clips', n + ' clip' + (n === 1 ? '' : 's'));
        node.querySelector('.entry-top').appendChild(tag);
      });
    });
  }

  /* ---------- linking clips to sessions ---------- */

  var pendingClipId = null;   // set when you choose to log a session for a fresh clip
  var linkClip = null;

  function handleClipSaved(clip) {
    linkClip = clip;

    var mins = Math.round(clip.durationMs / 1000);
    $('linkMeta').textContent = 'A ' + (mins < 60 ? mins + ' second' : Math.round(mins / 60) + ' minute') +
      ' clip from ' + prettyDate(clip.date).toLowerCase() +
      '. Linking it means you can jump to the footage from your session log.';

    var sameDay = sessions.filter(function (s) { return s.date === clip.date; });
    var list = $('linkList');
    list.textContent = '';

    sameDay.forEach(function (s) {
      var li = el('li');
      var b = el('button', 'linkrow');
      b.type = 'button';
      b.appendChild(el('span', 'linkrow-main',
        prettyDuration(s.minutes) + ' · ' + nf.format(s.balls) + ' balls'));
      b.appendChild(el('span', 'linkrow-sub', MECHANICS.map(function (m) {
        return m.name.slice(0, 2) + ' ' + s.grades[m.key];
      }).join('  ')));
      b.addEventListener('click', function () { attachTo(s.id); });
      li.appendChild(b);
      list.appendChild(li);
    });

    if (!sameDay.length) {
      var li2 = el('li');
      li2.appendChild(el('div', 'empty', 'No session logged for this date yet.'));
      list.appendChild(li2);
    }

    $('linkModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeLink() {
    $('linkModal').hidden = true;
    document.body.style.overflow = '';
    linkClip = null;
  }

  function startReview(clipId) {
    if (window.CourtLogReview) window.CourtLogReview.open(clipId, go);
  }

  function attachTo(sessionId) {
    if (!linkClip || !window.CourtLogClips) return closeLink();
    var id = linkClip.id;
    closeLink();
    window.CourtLogClips.setSession(id, sessionId).then(function () {
      toast('Clip attached to that session.');
      startReview(id);
    });
  }

  function skipLink() {
    var id = linkClip ? linkClip.id : null;
    closeLink();
    if (id) startReview(id);
  }

  function logSessionForClip() {
    if (!linkClip) return closeLink();
    pendingClipId = linkClip.id;
    var date = linkClip.date;
    closeLink();
    resetForm();
    $('fDate').value = date;
    go('log');
    toast('Log the session and the clip attaches itself.');
  }

  /* ---------- wipe career: three separate confirmations ---------- */

  var wipeStep = 0;
  var wipeClips = 0;

  function openWipe() {
    var pending = window.CourtLogClips
      ? window.CourtLogClips.count()
      : Promise.resolve(0);

    pending.then(function (n) {
      wipeClips = n;
      if (!sessions.length && !wipeClips) {
        toast('Nothing to wipe. Your career is already empty.');
        return;
      }
      wipeStep = 1;
      $('wipeModal').hidden = false;
      document.body.style.overflow = 'hidden';
      renderWipe();
    });
  }

  function closeWipe() {
    wipeStep = 0;
    $('wipeModal').hidden = true;
    document.body.style.overflow = '';
    $('wipeInput').value = '';
    $('wipeTypeField').hidden = true;
    $('wipeBtn').focus();
  }

  function renderWipe() {
    var st = computeStats();
    var body = $('wipeBody');
    body.textContent = '';

    $('wipeStep').textContent = 'Step ' + wipeStep + ' of 3';
    $('wipeTypeField').hidden = (wipeStep !== 3);
    $('wipeNext').disabled = false;

    if (wipeStep === 1) {
      $('wipeTitle').textContent = 'Wipe your entire career?';
      body.appendChild(el('p', null,
        'This clears every training session and recorded clip stored on this device, and resets all of your grades and statistics to zero.'));
      var ul = el('ul');
      ul.appendChild(el('li', null, nf.format(st.count) + ' logged session' + (st.count === 1 ? '' : 's')));
      ul.appendChild(el('li', null, nf.format(st.balls) + ' balls hit'));
      ul.appendChild(el('li', null, st.hours.toFixed(1) + ' hours on court'));
      if (wipeClips) {
        ul.appendChild(el('li', null, nf.format(wipeClips) + ' recorded clip' +
          (wipeClips === 1 ? '' : 's') + ', with every line call marked on them'));
      }
      if (st.firstDate) {
        ul.appendChild(el('li', null, 'History going back to ' + softDate(st.firstDate)));
      }
      body.appendChild(ul);
      $('wipeNext').textContent = 'Continue';
      $('wipeCancel').textContent = 'Keep my data';

    } else if (wipeStep === 2) {
      $('wipeTitle').textContent = 'This cannot be undone.';
      body.appendChild(el('p', null,
        'Baseline CourtLog keeps your data on this device only. There is no cloud copy, no backup and no restore.'));
      var p2 = el('p', null, 'Once you wipe, ');
      p2.appendChild(el('strong', null, 'every session and every clip is gone for good'));
      p2.appendChild(document.createTextNode(' and your odds of going pro return to zero.'));
      body.appendChild(p2);
      $('wipeNext').textContent = 'I understand, continue';
      $('wipeCancel').textContent = 'Go back';

    } else {
      $('wipeTitle').textContent = 'Final confirmation';
      body.appendChild(el('p', null,
        'Type the phrase below exactly as shown. This is the last step.'));
      $('wipeNext').textContent = 'Wipe Career';
      $('wipeNext').disabled = true;
      $('wipeCancel').textContent = 'Cancel';
      setTimeout(function () { $('wipeInput').focus(); }, 40);
    }
  }

  function advanceWipe() {
    if (wipeStep < 3) {
      wipeStep += 1;
      renderWipe();
      return;
    }
    if ($('wipeInput').value.trim().toUpperCase() !== 'WIPE CAREER') return;

    sessions = [];
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }

    var clipsGone = window.CourtLogClips
      ? window.CourtLogClips.clearAll()
      : Promise.resolve();

    closeWipe();
    clipsGone.then(function () {
      go('dashboard');
      toast('Career wiped. Clean slate.');
    });
  }

  /* ---------- wiring ---------- */

  function init() {
    window.CourtLogToast = toast;
    var stamp = $('buildStamp');
    if (stamp) stamp.textContent = 'Baseline CourtLog · ' + BUILD;
    applyTheme(currentTheme());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (currentTheme() === 'system') applyTheme('system');
    });

    $('themeBtn').addEventListener('click', cycleTheme);

    document.addEventListener('click', function (ev) {
      var trigger = ev.target.closest('[data-go]');
      if (trigger) go(trigger.dataset.go);
    });

    buildGradePicker();
    $('fDate').value = todayISO();
    $('fDate').max = todayISO();
    $('sessionForm').addEventListener('submit', handleSubmit);

    document.querySelectorAll('.chips').forEach(function (row) {
      var target = $(row.dataset.chips);
      row.addEventListener('click', function (ev) {
        var chip = ev.target.closest('.chip');
        if (!chip) return;
        if (chip.dataset.set != null) {
          target.value = chip.dataset.set;
        } else if (chip.dataset.add === 'clear') {
          target.value = '';
        } else if (chip.dataset.add != null) {
          target.value = (parseInt(target.value, 10) || 0) + parseInt(chip.dataset.add, 10);
        }
        target.classList.remove('invalid');
      });
    });

    $('wipeBtn').addEventListener('click', openWipe);
    $('wipeCancel').addEventListener('click', function () {
      if (wipeStep > 1) { wipeStep -= 1; renderWipe(); }
      else closeWipe();
    });
    $('wipeNext').addEventListener('click', advanceWipe);
    $('wipeInput').addEventListener('input', function () {
      $('wipeNext').disabled = this.value.trim().toUpperCase() !== 'WIPE CAREER';
    });
    $('wipeModal').addEventListener('click', function (ev) {
      if (ev.target === this) closeWipe();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('wipeModal').hidden) closeWipe();
    });

    $('linkSkip').addEventListener('click', skipLink);
    $('linkNew').addEventListener('click', logSessionForClip);
    $('linkModal').addEventListener('click', function (ev) {
      if (ev.target === this) skipLink();
    });

    if (window.CourtLogReview) window.CourtLogReview.init(go);

    if (window.CourtLogClips) {
      window.CourtLogClips.onClipSaved = handleClipSaved;
      window.CourtLogClips.onAnalyse = startReview;
      window.CourtLogClips.init();
    }

    go('dashboard');

    /* Offline cache is for the hosted web build only. Inside a native
       Capacitor shell the files already ship with the app. */
    if ('serviceWorker' in navigator && !window.Capacitor &&
        document.querySelector('link[rel="manifest"]') &&
        location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
