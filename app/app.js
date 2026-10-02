(function () {
  'use strict';

  var STORAGE_KEY = 'teamshuffle:data:v1';
  var desktop = window.desktop || null;
  var B = window.Balancer;
  var TEAM_COLORS = [
    ['#ee6a24', '#c2520f'], ['#2f6fdb', '#2259b8'], ['#2e9b57', '#237a44'], ['#d3415b', '#b3304a'],
    ['#d9a514', '#94700a'], ['#7a52cc', '#6440b0'], ['#1a93a0', '#13737d'], ['#8c6648', '#73523a'],
    ['#55606e', '#444d58'], ['#b8489f', '#983a83']
  ];
  var MIN_TEAMS = 2, MAX_TEAMS = 30;

  var state = defaultState();
  var ui = { tab: 'draw', filter: 'all', search: '', rosterSearch: '', selected: null, pairPerson: '' };
  var dragId = null;
  var modal = { resolve: null, collect: null };
  var toastTimer = null;
  var saveChain = Promise.resolve();

  /* ---------- helpers ---------- */
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function newId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function timeStr(d) { d = d || new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function weekday(dateStr) {
    var p = String(dateStr).split('-').map(Number);
    if (p.length !== 3 || !p[0]) return '';
    return '일월화수목금토'.charAt(new Date(p[0], p[1] - 1, p[2]).getDay());
  }
  function byName(a, b) { return a.name.localeCompare(b.name, 'ko'); }
  function labelOf(group) { return group === 'a' ? state.settings.labelA : state.settings.labelB; }
  function genderText(g) { return g === 'm' ? '남' : '여'; }
  function markHtml(g) { return '<span class="mark mark-' + g + '">' + genderText(g) + '</span>'; }
  function memberMap() {
    var m = Object.create(null);
    state.members.forEach(function (p) { m[p.id] = p; });
    return m;
  }
  function closestEl(target, sel) {
    var el = target && target.nodeType === 1 ? target : (target && target.parentElement);
    return el ? el.closest(sel) : null;
  }
  function teamColor(i) { return TEAM_COLORS[i % TEAM_COLORS.length]; }
  function hasRule(list, a, b) {
    return list.some(function (r) { return (r[0] === a && r[1] === b) || (r[0] === b && r[1] === a); });
  }

  /* ---------- state ---------- */
  function defaultState() {
    return {
      version: 1,
      settings: { title: '팀 랜덤 추첨기', labelA: '장년', labelB: '청년', teamCount: 4, useHistory: true },
      members: [],
      rules: { pairs: [], separates: [] },
      history: [],
      draft: null
    };
  }

  function cleanText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

  function normalize(raw) {
    var s = defaultState();
    if (!raw || typeof raw !== 'object') return s;
    var st = raw.settings || {};
    s.settings.title = cleanText(st.title, 40) || s.settings.title;
    s.settings.labelA = cleanText(st.labelA, 10) || s.settings.labelA;
    s.settings.labelB = cleanText(st.labelB, 10) || s.settings.labelB;
    if (Number.isInteger(st.teamCount) && st.teamCount >= MIN_TEAMS && st.teamCount <= MAX_TEAMS) s.settings.teamCount = st.teamCount;
    if (typeof st.useHistory === 'boolean') s.settings.useHistory = st.useHistory;

    var seen = Object.create(null);
    (Array.isArray(raw.members) ? raw.members : []).forEach(function (m) {
      if (!m) return;
      var name = cleanText(m.name, 30);
      if (!name) return;
      var id = typeof m.id === 'string' && m.id && !seen[m.id] ? m.id : newId();
      seen[id] = true;
      s.members.push({ id: id, name: name, gender: m.gender === 'f' ? 'f' : 'm', group: m.group === 'b' ? 'b' : 'a', present: m.present !== false });
    });

    var rules = raw.rules || {};
    ['pairs', 'separates'].forEach(function (k) {
      (Array.isArray(rules[k]) ? rules[k] : []).forEach(function (r) {
        if (!Array.isArray(r) || r.length !== 2 || r[0] === r[1] || !seen[r[0]] || !seen[r[1]]) return;
        if (!hasRule(s.rules[k], r[0], r[1])) s.rules[k].push([r[0], r[1]]);
      });
    });

    (Array.isArray(raw.history) ? raw.history : []).forEach(function (h) {
      if (!h || !Array.isArray(h.teams)) return;
      var teams = h.teams.map(function (t) {
        return (Array.isArray(t) ? t : []).filter(function (x) { return x && typeof x.id === 'string'; })
          .map(function (x) { return { id: x.id, name: String(x.name || '') }; });
      });
      s.history.push({
        id: typeof h.id === 'string' && h.id ? h.id : newId(),
        date: typeof h.date === 'string' ? h.date : '',
        time: typeof h.time === 'string' ? h.time : '',
        teams: teams
      });
    });

    if (raw.draft && Array.isArray(raw.draft.teams)) {
      s.draft = {
        teams: raw.draft.teams.map(function (t) {
          return (Array.isArray(t) ? t : []).filter(function (id) { return seen[id]; });
        }),
        confirmedId: typeof raw.draft.confirmedId === 'string' ? raw.draft.confirmedId : null
      };
    }
    return s;
  }

  function save() {
    var json = JSON.stringify(state);
    if (desktop) {
      saveChain = saveChain
        .then(function () { return desktop.saveData(json); })
        .then(function (ok) { if (!ok) toast('저장하지 못했습니다. 디스크 공간이나 권한을 확인해 주세요.'); })
        .catch(function () { toast('저장하지 못했습니다.'); });
    } else {
      try { localStorage.setItem(STORAGE_KEY, json); }
      catch (e) { toast('브라우저 저장소에 저장하지 못했습니다.'); }
    }
  }

  function load() {
    var get = desktop
      ? desktop.loadData()
      : Promise.resolve((function () { try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } })());
    return get.then(function (raw) {
      if (!raw) return;
      try { state = normalize(JSON.parse(raw)); }
      catch (e) { state = defaultState(); toast('저장된 데이터를 읽지 못했습니다. 백업 파일이 있다면 설정에서 불러오세요.'); }
    }).catch(function () { /* start empty */ });
  }

  function isConfirmed() {
    var d = state.draft;
    return !!(d && d.confirmedId && state.history.some(function (h) { return h.id === d.confirmedId; }));
  }

  function draftTeams() {
    if (!state.draft) return null;
    var map = memberMap();
    return state.draft.teams.map(function (t) { return t.filter(function (id) { return map[id]; }); });
  }

  function sortIds(ids) {
    var map = memberMap();
    return ids.slice().sort(function (a, b) { return byName(map[a], map[b]); });
  }

  function pairCounts() { return B.pairCountsFromHistory(state.history); }

  /* ---------- toast & modal ---------- */
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 3200);
  }

  function ask(opts) {
    return new Promise(function (resolve) {
      $('#modalTitle').textContent = opts.title;
      $('#modalBody').innerHTML = opts.body || '';
      var ok = $('#modalOk');
      ok.textContent = opts.ok || '확인';
      ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      $('#modalCancel').textContent = opts.cancel || '취소';
      modal.resolve = resolve;
      modal.collect = opts.collect || null;
      $('#modal').showModal();
      var first = $('#modalBody input, #modalBody select');
      (first || ok).focus();
    });
  }
  function closeModal(value) {
    var r = modal.resolve;
    modal.resolve = null; modal.collect = null;
    if ($('#modal').open) $('#modal').close();
    if (r) r(value);
  }
  function modalOk() {
    if (modal.collect) {
      var v = modal.collect();
      if (v === false) return;
      closeModal(v);
    } else {
      closeModal(true);
    }
  }

  /* ---------- rendering ---------- */
  function renderAll() {
    renderLabels();
    renderDraw();
    renderRoster();
    renderHistory();
    renderPairs();
    renderSettings();
  }

  function renderLabels() {
    $('#appTitle').textContent = state.settings.title;
    document.title = state.settings.title;
    $$('.label-a').forEach(function (el) { el.textContent = state.settings.labelA; });
    $$('.label-b').forEach(function (el) { el.textContent = state.settings.labelB; });
    $('#bulkHint').textContent = '한 줄에 한 사람씩 이름, 성별, 구분 순서로 적습니다. 쉼표나 탭으로 나눠 주세요.';
    $('#bulkText').placeholder = '홍길동, 남, ' + state.settings.labelA + '\n김영희, 여, ' + state.settings.labelB;
  }

  function renderDraw() {
    renderAttendance();
    renderRules();
    renderBoard();
  }

  function renderAttendance() {
    var all = state.members;
    var present = all.filter(function (m) { return m.present; });
    var cnt = function (fn) { return present.filter(fn).length; };
    $('#attendanceCount').textContent = all.length ? '출석 ' + present.length + ' / ' + all.length + '명' : '';
    $('#attendanceTally').innerHTML = all.length ? [
      ['남', cnt(function (m) { return m.gender === 'm'; })],
      ['여', cnt(function (m) { return m.gender === 'f'; })],
      [state.settings.labelA, cnt(function (m) { return m.group === 'a'; })],
      [state.settings.labelB, cnt(function (m) { return m.group === 'b'; })]
    ].map(function (x) { return '<span>' + esc(x[0]) + '<b>' + x[1] + '</b></span>'; }).join('') : '';

    var filters = [['all', '전체'], ['m', '남'], ['f', '여'], ['a', state.settings.labelA], ['b', state.settings.labelB], ['absent', '결석']];
    $('#attendFilter').innerHTML = filters.map(function (f) {
      return '<button type="button" data-action="attend-filter" data-filter="' + f[0] + '" class="' + (ui.filter === f[0] ? 'is-active' : '') + '">' + esc(f[1]) + '</button>';
    }).join('');

    if (!all.length) {
      $('#attendList').innerHTML = '<p class="empty">아직 명단이 없습니다. <button type="button" class="link-btn" data-action="tab" data-tab="roster">명단에서 사람을 추가하세요.</button></p>';
      return;
    }
    var list = visibleAttendance();
    $('#attendList').innerHTML = list.length ? list.map(function (m) {
      return '<button type="button" class="chip' + (m.present ? '' : ' is-absent') + '" data-action="toggle-present" data-id="' + esc(m.id) + '" aria-pressed="' + m.present + '">' +
        markHtml(m.gender) + '<span class="chip-name">' + esc(m.name) + '</span><span class="grp">' + esc(labelOf(m.group)) + '</span></button>';
    }).join('') : '<p class="empty">조건에 맞는 사람이 없습니다.</p>';
  }

  function visibleAttendance() {
    var q = ui.search.trim();
    return state.members.filter(function (m) {
      if (q && m.name.indexOf(q) === -1) return false;
      switch (ui.filter) {
        case 'm': return m.gender === 'm';
        case 'f': return m.gender === 'f';
        case 'a': return m.group === 'a';
        case 'b': return m.group === 'b';
        case 'absent': return !m.present;
        default: return true;
      }
    }).sort(byName);
  }

  function renderRules() {
    var sorted = state.members.slice().sort(byName);
    ['#ruleA', '#ruleB'].forEach(function (sel, i) {
      var el = $(sel);
      var prev = el.value;
      el.innerHTML = '<option value="">' + (i === 0 ? '첫 번째 사람' : '두 번째 사람') + '</option>' +
        sorted.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('');
      if (prev && sorted.some(function (m) { return m.id === prev; })) el.value = prev;
    });
    var map = memberMap();
    var html = '';
    [['pairs', '꼭 같은 팀'], ['separates', '꼭 다른 팀']].forEach(function (k) {
      var list = state.rules[k[0]];
      if (!list.length) return;
      html += '<p class="rule-group-title">' + k[1] + '</p>';
      list.forEach(function (r, i) {
        var a = map[r[0]], b = map[r[1]];
        if (!a || !b) return;
        var off = !a.present || !b.present;
        html += '<div class="rule-item ' + k[0] + '"><span>' + esc(a.name) + ', ' + esc(b.name) +
          (off ? '<span class="off">결석이 있어 오늘은 적용 안 됨</span>' : '') + '</span>' +
          '<button type="button" class="icon-btn danger" data-action="remove-rule" data-kind="' + k[0] + '" data-index="' + i + '" aria-label="규칙 지우기">지우기</button></div>';
      });
    });
    $('#ruleList').innerHTML = html;
  }

  function renderBoard() {
    var T = state.settings.teamCount;
    $('#teamCountOut').textContent = T;
    var presentN = state.members.filter(function (m) { return m.present; }).length;
    var per = '';
    if (presentN && presentN >= T) {
      var lo = Math.floor(presentN / T), hi = Math.ceil(presentN / T);
      per = '팀당 ' + (lo === hi ? lo : lo + '~' + hi) + '명';
    } else if (presentN) {
      per = '출석 인원보다 팀이 많습니다';
    }
    $('#perTeam').textContent = per;
    $('#shuffleBtn').textContent = state.draft ? '다시 나누기' : '팀 나누기';
    $('#shuffleBtn').className = 'btn ' + (state.draft ? 'btn-quiet' : 'btn-primary');
    $('#shuffleBtn').disabled = !state.members.length;

    var body = $('#boardBody');
    if (!state.members.length) {
      body.innerHTML = '<div class="board-empty"><p>먼저 명단을 만들어 주세요.</p><p>이름, 성별, 구분만 있으면 됩니다.</p>' +
        '<button type="button" class="btn btn-primary" data-action="tab" data-tab="roster">명단 만들기</button></div>';
      return;
    }
    var teams = draftTeams();
    if (!teams) {
      var h = state.history.length && state.settings.useHistory
        ? '<p>확정한 편성 ' + state.history.length + '회를 참고해, 같은 팀이었던 사람들은 되도록 다른 팀으로 보냅니다.</p>' : '';
      body.innerHTML = '<div class="board-empty"><p>출석을 확인하고 팀 수를 정한 뒤 팀 나누기를 누르세요.</p>' + h + '</div>';
      return;
    }

    var map = memberMap();
    var counts = state.settings.useHistory ? pairCounts() : {};
    var locked = isConfirmed();
    var desc = B.describe(teams, map, counts);
    var entry = locked ? state.history.filter(function (x) { return x.id === state.draft.confirmedId; })[0] : null;

    var html = '<div class="result-head"><h2>결과</h2>' +
      (locked ? '<span class="status status-done">' + esc(entry.date) + ' 확정됨</span>' : '<span class="status status-draft">확정 전</span>') + '</div>';

    html += '<div class="team-grid' + (locked ? ' locked' : '') + '">' + teams.map(function (ids, ti) {
      var col = teamColor(ti);
      var st = desc.perTeam[ti];
      var target = ui.selected && !locked && teams[ti].indexOf(ui.selected) === -1;
      return '<article class="team' + (target ? ' is-target' : '') + '" data-action="drop-team" data-team="' + ti + '" style="--team:' + col[0] + ';--team-ink:' + col[1] + '">' +
        '<div class="team-band"></div>' +
        '<div class="team-top"><span class="team-name">' + (ti + 1) + '팀</span>' +
        (target ? '<button type="button" class="link-btn" data-action="drop-team" data-team="' + ti + '">여기로 옮기기</button>' : '<span class="team-size">' + st.size + '명</span>') + '</div>' +
        '<ul class="members">' + ids.map(function (id) {
          var m = map[id];
          return '<li><button type="button" class="member' + (ui.selected === id ? ' is-selected' : '') + '"' + (locked ? '' : ' draggable="true"') +
            ' data-action="pick-member" data-id="' + esc(id) + '" data-team="' + ti + '">' + markHtml(m.gender) +
            '<span class="member-name">' + esc(m.name) + '</span><span class="grp">' + esc(labelOf(m.group)) + '</span></button></li>';
        }).join('') + '</ul>' +
        '<div class="team-foot"><span>남 ' + st.m + '</span><span>여 ' + st.f + '</span><span>' + esc(state.settings.labelA) + ' ' + st.a +
        '</span><span>' + esc(state.settings.labelB) + ' ' + st.b + '</span>' +
        (st.repeatPairs ? '<span class="again">전에 같은 팀이었던 사이 ' + st.repeatPairs + '쌍</span>' : '') + '</div></article>';
    }).join('') + '</div>';

    var rows = [['인원', desc.size], ['남', desc.m], ['여', desc.f], [state.settings.labelA, desc.a], [state.settings.labelB, desc.b]];
    html += '<dl class="balance">' + rows.map(function (r) {
      var good = r[1].max - r[1].min <= 1;
      var range = r[1].min === r[1].max ? r[1].min + '명씩' : r[1].min + '~' + r[1].max + '명';
      return '<div class="' + (good ? 'ok' : 'off') + '"><dt>팀별 ' + esc(r[0]) + '</dt><dd>' + range +
        ' <span class="verdict">' + (good ? '고름' : '차이 큼') + '</span></dd></div>';
    }).join('') + '</dl>';

    html += '<div class="notes">' + boardNotes(teams, map).join('') + '</div>';

    if (locked) {
      html += '<div class="board-actions"><button type="button" class="btn btn-quiet" data-action="copy">결과 복사</button>' +
        '<button type="button" class="btn btn-quiet" data-action="print">인쇄</button><span class="spacer"></span>' +
        '<button type="button" class="btn btn-quiet" data-action="unconfirm">확정 취소</button></div>' +
        '<p class="move-help">확정한 편성은 옮길 수 없습니다. 고치려면 확정을 취소하세요.</p>';
    } else {
      html += '<div class="board-actions"><button type="button" class="btn btn-primary" data-action="confirm">이 편성으로 확정</button>' +
        '<button type="button" class="btn btn-quiet" data-action="copy">결과 복사</button>' +
        '<button type="button" class="btn btn-quiet" data-action="print">인쇄</button></div>' +
        '<p class="move-help">이름을 다른 팀으로 끌어다 놓으면 옮겨집니다. 이름을 누른 뒤 다른 팀의 이름을 누르면 두 사람이 서로 바뀌고, 다른 팀의 빈 곳을 누르면 그 팀으로 옮겨집니다.</p>';
    }
    body.innerHTML = html;
  }

  function boardNotes(teams, map) {
    var notes = [];
    var teamOf = Object.create(null);
    teams.forEach(function (t, i) { t.forEach(function (id) { teamOf[id] = i; }); });
    state.rules.separates.forEach(function (r) {
      if (teamOf[r[0]] !== undefined && teamOf[r[0]] === teamOf[r[1]]) {
        notes.push('<p class="note">꼭 다른 팀 규칙이 지켜지지 않았습니다: ' + esc(map[r[0]].name) + ', ' + esc(map[r[1]].name) + ' (' + (teamOf[r[0]] + 1) + '팀)</p>');
      }
    });
    state.rules.pairs.forEach(function (r) {
      if (teamOf[r[0]] !== undefined && teamOf[r[1]] !== undefined && teamOf[r[0]] !== teamOf[r[1]]) {
        notes.push('<p class="note">꼭 같은 팀 규칙이 지켜지지 않았습니다: ' + esc(map[r[0]].name) + ', ' + esc(map[r[1]].name) + '</p>');
      }
    });
    if (!isConfirmed()) {
      var inDraft = Object.keys(teamOf).length;
      var presentIds = state.members.filter(function (m) { return m.present; }).map(function (m) { return m.id; });
      var changed = presentIds.length !== inDraft || presentIds.some(function (id) { return teamOf[id] === undefined; });
      if (changed) notes.push('<p class="note info">결과를 만든 뒤 출석이나 명단이 바뀌었습니다. 다시 나누면 반영됩니다.</p>');
      if (teams.length !== state.settings.teamCount) notes.push('<p class="note info">팀 수를 바꿨습니다. 다시 나누면 반영됩니다.</p>');
    }
    return notes;
  }

  function renderRoster() {
    var all = state.members;
    $('#rosterCount').textContent = all.length ? all.length + '명' : '';
    var q = ui.rosterSearch.trim();
    var list = all.filter(function (m) { return !q || m.name.indexOf(q) !== -1; }).sort(byName);
    if (!all.length) {
      $('#rosterList').innerHTML = '<p class="empty">아직 아무도 없습니다. 왼쪽에서 한 명씩 추가하거나 여러 명을 한꺼번에 붙여 넣으세요.</p>';
      return;
    }
    if (!list.length) {
      $('#rosterList').innerHTML = '<p class="empty">검색어에 맞는 사람이 없습니다.</p>';
      return;
    }
    $('#rosterList').innerHTML =
      '<table class="roster-table"><thead><tr><th>이름</th><th>성별</th><th>구분</th><th></th></tr></thead><tbody>' +
      list.map(function (m) {
        return '<tr><td>' + esc(m.name) + '</td><td>' + markHtml(m.gender) + '</td><td>' + esc(labelOf(m.group)) + '</td>' +
          '<td class="actions"><button type="button" class="icon-btn" data-action="edit-member" data-id="' + esc(m.id) + '">수정</button>' +
          '<button type="button" class="icon-btn danger" data-action="delete-member" data-id="' + esc(m.id) + '">삭제</button></td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderHistory() {
    var h = state.history;
    $('#historyCount').textContent = h.length ? h.length + '회' : '';
    if (!h.length) {
      $('#historyList').innerHTML = '<p class="empty">아직 확정한 편성이 없습니다. 팀을 나눈 뒤 이 편성으로 확정을 누르면 여기에 쌓입니다.</p>';
      return;
    }
    $('#historyList').innerHTML = h.map(function (e) {
      var people = e.teams.reduce(function (s, t) { return s + t.length; }, 0);
      return '<article class="hist"><div class="hist-head"><div><b>' + esc(e.date) + (weekday(e.date) ? ' (' + weekday(e.date) + ')' : '') + '</b>' +
        '<span>' + esc(e.time) + '</span><span>' + e.teams.length + '팀, ' + people + '명</span></div>' +
        '<button type="button" class="icon-btn danger" data-action="delete-history" data-id="' + esc(e.id) + '">지우기</button></div>' +
        '<div class="hist-teams">' + e.teams.map(function (t, i) {
          return '<div class="hist-team" style="--team:' + teamColor(i)[0] + '"><b>' + (i + 1) + '팀</b>' + t.map(function (m) { return esc(m.name); }).join(', ') + '</div>';
        }).join('') + '</div></article>';
    }).join('');
  }

  function renderPairs() {
    var members = state.members.slice().sort(byName);
    var sel = $('#pairPerson');
    if (!members.length) {
      sel.innerHTML = '';
      $('#pairDetail').innerHTML = '<p class="empty">명단이 비어 있습니다.</p>';
      $('#topPairs').innerHTML = '';
      return;
    }
    if (!members.some(function (m) { return m.id === ui.pairPerson; })) ui.pairPerson = members[0].id;
    sel.innerHTML = members.map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (m.id === ui.pairPerson ? ' selected' : '') + '>' + esc(m.name) + '</option>';
    }).join('');
    if (!state.history.length) {
      $('#pairDetail').innerHTML = '<p class="empty">아직 확정한 편성이 없어 셀 것이 없습니다.</p>';
      $('#topPairs').innerHTML = '';
      return;
    }
    var counts = pairCounts();
    var me = ui.pairPerson;
    var met = [], never = [];
    members.forEach(function (m) {
      if (m.id === me) return;
      var c = counts[B.pairKey(me, m.id)] || 0;
      if (c) met.push({ m: m, c: c }); else never.push(m);
    });
    met.sort(function (a, b) { return b.c - a.c || byName(a.m, b.m); });
    var maxC = met.length ? met[0].c : 1;
    $('#pairDetail').innerHTML = '<div class="pair-cols"><div><h3>같은 팀이었던 사람</h3>' +
      (met.length ? '<ul class="pair-list">' + met.map(function (x) {
        return '<li><span class="who">' + esc(x.m.name) + '</span><span class="num">' + x.c + '회</span><span class="bar" style="width:' + Math.round(x.c / maxC * 120) + 'px"></span></li>';
      }).join('') + '</ul>' : '<p class="empty">없음</p>') +
      '</div><div><h3>아직 같은 팀이 된 적 없는 사람 ' + never.length + '명</h3>' +
      (never.length ? '<div class="never">' + never.map(function (m) { return '<span>' + esc(m.name) + '</span>'; }).join('') + '</div>' : '<p class="empty">모두 한 번 이상 같은 팀이었습니다.</p>') +
      '</div></div>';

    var top = [];
    for (var i = 0; i < members.length; i++) {
      for (var j = i + 1; j < members.length; j++) {
        var c = counts[B.pairKey(members[i].id, members[j].id)] || 0;
        if (c) top.push({ a: members[i], b: members[j], c: c });
      }
    }
    top.sort(function (x, y) { return y.c - x.c || byName(x.a, y.a); });
    top = top.slice(0, 15);
    var maxT = top.length ? top[0].c : 1;
    $('#topPairs').innerHTML = top.length ? '<ul class="pair-list">' + top.map(function (x) {
      return '<li><span class="who">' + esc(x.a.name) + ', ' + esc(x.b.name) + '</span><span class="num">' + x.c + '회</span><span class="bar" style="width:' + Math.round(x.c / maxT * 160) + 'px"></span></li>';
    }).join('') + '</ul>' : '<p class="empty">없음</p>';
  }

  function renderSettings() {
    $('#setTitle').value = state.settings.title;
    $('#setLabelA').value = state.settings.labelA;
    $('#setLabelB').value = state.settings.labelB;
    $('#setUseHistory').checked = state.settings.useHistory;
  }

  function switchTab(tab) {
    ui.tab = tab;
    $$('.tab-btn').forEach(function (b) { b.classList.toggle('is-active', b.dataset.tab === tab); });
    $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.id === 'view-' + tab); });
    window.scrollTo(0, 0);
  }

  /* ---------- actions ---------- */
  function shuffleTeams() {
    var present = state.members.filter(function (m) { return m.present; });
    var T = state.settings.teamCount;
    if (!present.length) { toast('출석한 사람이 없습니다.'); return; }
    if (present.length < T) { toast('출석 ' + present.length + '명으로는 ' + T + '팀을 만들 수 없습니다. 팀 수를 줄여 주세요.'); return; }
    var result;
    try {
      result = B.makeTeams(present, T, {
        pairs: state.rules.pairs,
        separates: state.rules.separates,
        pairCounts: state.settings.useHistory ? pairCounts() : {}
      });
    } catch (e) { toast(e.message); return; }
    state.draft = { teams: result.teams.map(sortIds), confirmedId: null };
    ui.selected = null;
    save();
    renderBoard();
    if (result.impossibleSeparates.length || result.unmetSeparates.length) {
      toast('지킬 수 없는 꼭 다른 팀 규칙이 있습니다. 결과 아래 안내를 확인하세요.');
    } else {
      toast('팀을 나눴습니다.');
    }
  }

  function moveMember(id, to) {
    if (!state.draft || isConfirmed()) return;
    var teams = state.draft.teams;
    var from = -1;
    teams.forEach(function (t, i) { if (t.indexOf(id) !== -1) from = i; });
    if (from < 0 || from === to || !teams[to]) return;
    teams[from] = teams[from].filter(function (x) { return x !== id; });
    teams[to] = sortIds(teams[to].concat([id]));
    ui.selected = null;
    save();
    renderBoard();
    toast(memberMap()[id].name + '님을 ' + (to + 1) + '팀으로 옮겼습니다.');
  }

  function swapMembers(a, b) {
    if (!state.draft || isConfirmed()) return;
    var teams = state.draft.teams;
    var ta = -1, tb = -1;
    teams.forEach(function (t, i) { if (t.indexOf(a) !== -1) ta = i; if (t.indexOf(b) !== -1) tb = i; });
    if (ta < 0 || tb < 0 || ta === tb) return;
    teams[ta] = sortIds(teams[ta].filter(function (x) { return x !== a; }).concat([b]));
    teams[tb] = sortIds(teams[tb].filter(function (x) { return x !== b; }).concat([a]));
    ui.selected = null;
    save();
    renderBoard();
    var map = memberMap();
    toast(map[a].name + '님과 ' + map[b].name + '님을 서로 바꿨습니다.');
  }

  function confirmDraft() {
    var teams = draftTeams();
    if (!teams || isConfirmed()) return;
    ask({
      title: '이 편성으로 확정할까요?',
      body: '<p>오늘 날짜로 이력에 저장됩니다. 다음에 팀을 나눌 때 이번에 같은 팀이었던 사람들은 되도록 다른 팀으로 갑니다.</p>',
      ok: '확정'
    }).then(function (ok) {
      if (!ok) return;
      var map = memberMap();
      var entry = {
        id: newId(), date: todayStr(), time: timeStr(),
        teams: teams.map(function (t) { return t.map(function (id) { return { id: id, name: map[id].name }; }); })
      };
      state.history.unshift(entry);
      state.draft.teams = teams;
      state.draft.confirmedId = entry.id;
      ui.selected = null;
      save();
      renderAll();
      toast('확정했습니다. 이력에 저장되었습니다.');
    });
  }

  function unconfirm() {
    if (!isConfirmed()) return;
    ask({
      title: '확정을 취소할까요?',
      body: '<p>이력에서 이 편성이 지워지고, 다시 사람을 옮길 수 있게 됩니다.</p>',
      ok: '확정 취소', danger: true
    }).then(function (ok) {
      if (!ok) return;
      var id = state.draft.confirmedId;
      state.history = state.history.filter(function (h) { return h.id !== id; });
      state.draft.confirmedId = null;
      save();
      renderAll();
      toast('확정을 취소했습니다.');
    });
  }

  function resultText() {
    var teams = draftTeams();
    if (!teams) return '';
    var map = memberMap();
    var lines = [state.settings.title + ' 팀 편성 (' + todayStr() + ')', ''];
    teams.forEach(function (t, i) {
      lines.push((i + 1) + '팀 (' + t.length + '명): ' + t.map(function (id) { return map[id].name; }).join(', '));
    });
    return lines.join('\n');
  }

  function copyText(text) {
    var done = function () { toast('결과를 복사했습니다.'); };
    if (desktop) { desktop.copyText(text).then(done); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  function saveFile(name, content, mime) {
    if (desktop) {
      return desktop.saveFile(name, content).then(function (r) { if (r && r.ok) toast('저장했습니다: ' + r.path); else if (r && r.error) toast('저장하지 못했습니다: ' + r.error); });
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('파일을 내려받았습니다.');
    return Promise.resolve();
  }

  /* ---------- roster ---------- */
  function nameTaken(name, exceptId) {
    return state.members.some(function (m) { return m.name === name && m.id !== exceptId; });
  }

  function addMember(name, gender, group) {
    state.members.push({ id: newId(), name: name, gender: gender, group: group, present: true });
  }

  function genderOf(t) {
    var s = t.trim().toLowerCase();
    if (['남', '남자', '남성', 'm', 'male'].indexOf(s) !== -1) return 'm';
    if (['여', '여자', '여성', 'f', 'female'].indexOf(s) !== -1) return 'f';
    return null;
  }
  function groupOf(t) {
    var s = t.trim();
    var A = state.settings.labelA, Bl = state.settings.labelB;
    if (s === A || s.toLowerCase() === 'a') return 'a';
    if (s === Bl || s.toLowerCase() === 'b') return 'b';
    if (A.charAt(0) !== Bl.charAt(0)) {
      if (s === A.charAt(0)) return 'a';
      if (s === Bl.charAt(0)) return 'b';
    }
    return null;
  }

  function parseLine(line) {
    var tokens = line.split(/[,\t;]+/).map(function (t) { return t.trim(); }).filter(Boolean);
    if (tokens.length === 1 && /\s/.test(tokens[0])) tokens = tokens[0].split(/\s+/);
    if (!tokens.length) return null;
    var name = tokens.shift();
    var dash = name.match(/^(.+?)\s*-\s*(\S+)$/);
    if (dash && (genderOf(dash[2]) || groupOf(dash[2]))) { name = dash[1].trim(); tokens.unshift(dash[2]); }
    var gender = null, group = null;
    tokens.forEach(function (t) {
      var g = genderOf(t);
      if (g && !gender) { gender = g; return; }
      var gr = groupOf(t);
      if (gr && !group) group = gr;
    });
    return { name: name.slice(0, 30), gender: gender, group: group };
  }

  function bulkAdd() {
    var lines = $('#bulkText').value.split(/\r?\n/);
    var added = 0, bad = [], dup = [];
    lines.forEach(function (line) {
      if (!line.trim()) return;
      var p = parseLine(line);
      if (!p || !p.name || !p.gender || !p.group) { bad.push(line); return; }
      if (nameTaken(p.name)) { dup.push(p.name); return; }
      addMember(p.name, p.gender, p.group);
      added++;
    });
    $('#bulkText').value = bad.join('\n');
    if (added) save();
    renderAll();
    var msg = added + '명을 추가했습니다.';
    if (dup.length) msg += ' 이미 있는 이름 ' + dup.length + '명은 건너뛰었습니다.';
    if (bad.length) msg += ' 형식을 알아보지 못한 ' + bad.length + '줄을 입력 칸에 남겨 두었습니다.';
    toast(msg);
  }

  function memberFormHtml(m) {
    return '<label class="lbl">이름<input type="text" id="editName" class="field" maxlength="30" value="' + esc(m.name) + '"></label>' +
      '<fieldset class="radio-row"><legend>성별</legend>' +
      '<label><input type="radio" name="editGender" value="m"' + (m.gender === 'm' ? ' checked' : '') + '> 남</label>' +
      '<label><input type="radio" name="editGender" value="f"' + (m.gender === 'f' ? ' checked' : '') + '> 여</label></fieldset>' +
      '<fieldset class="radio-row"><legend>구분</legend>' +
      '<label><input type="radio" name="editGroup" value="a"' + (m.group === 'a' ? ' checked' : '') + '> ' + esc(state.settings.labelA) + '</label>' +
      '<label><input type="radio" name="editGroup" value="b"' + (m.group === 'b' ? ' checked' : '') + '> ' + esc(state.settings.labelB) + '</label></fieldset>' +
      '<p class="hint" id="editError"></p>';
  }

  function editMember(id) {
    var m = memberMap()[id];
    if (!m) return;
    ask({
      title: '사람 정보 수정',
      body: memberFormHtml(m),
      ok: '저장',
      collect: function () {
        var name = $('#editName').value.trim();
        if (!name) { $('#editError').textContent = '이름을 적어 주세요.'; return false; }
        if (nameTaken(name, id)) { $('#editError').textContent = '같은 이름이 이미 있습니다. 구별할 수 있게 적어 주세요.'; return false; }
        return {
          name: name.slice(0, 30),
          gender: $('input[name="editGender"]:checked').value,
          group: $('input[name="editGroup"]:checked').value
        };
      }
    }).then(function (v) {
      if (!v) return;
      m.name = v.name; m.gender = v.gender; m.group = v.group;
      save();
      renderAll();
      toast('저장했습니다.');
    });
  }

  function deleteMember(id) {
    var m = memberMap()[id];
    if (!m) return;
    ask({
      title: m.name + '님을 명단에서 지울까요?',
      body: '<p>이 사람이 들어간 함께/따로 규칙도 지워집니다. 지난 이력에는 이름이 그대로 남습니다.</p>',
      ok: '지우기', danger: true
    }).then(function (ok) {
      if (!ok) return;
      state.members = state.members.filter(function (x) { return x.id !== id; });
      ['pairs', 'separates'].forEach(function (k) {
        state.rules[k] = state.rules[k].filter(function (r) { return r[0] !== id && r[1] !== id; });
      });
      if (state.draft) {
        state.draft.teams = state.draft.teams.map(function (t) { return t.filter(function (x) { return x !== id; }); });
      }
      if (ui.selected === id) ui.selected = null;
      save();
      renderAll();
      toast(m.name + '님을 지웠습니다.');
    });
  }

  /* ---------- events ---------- */
  var actions = {
    'tab': function (el) { switchTab(el.dataset.tab); },
    'attend-filter': function (el) { ui.filter = el.dataset.filter; renderAttendance(); },
    'toggle-present': function (el) {
      var m = memberMap()[el.dataset.id];
      if (!m) return;
      m.present = !m.present;
      save();
      renderDraw();
    },
    'mark-all': function (el) {
      var present = el.dataset.present === '1';
      var targets = present ? visibleAttendance() : state.members;
      targets.forEach(function (m) { m.present = present; });
      save();
      renderDraw();
    },
    'team-step': function (el) {
      var next = state.settings.teamCount + Number(el.dataset.step);
      if (next < MIN_TEAMS || next > MAX_TEAMS) return;
      state.settings.teamCount = next;
      save();
      renderBoard();
    },
    'shuffle': function () { shuffleTeams(); },
    'add-rule': function (el) {
      var a = $('#ruleA').value, b = $('#ruleB').value, kind = el.dataset.kind;
      if (!a || !b) { toast('두 사람을 고르세요.'); return; }
      if (a === b) { toast('서로 다른 두 사람을 고르세요.'); return; }
      var other = kind === 'pairs' ? 'separates' : 'pairs';
      if (hasRule(state.rules[kind], a, b)) { toast('이미 있는 규칙입니다.'); return; }
      if (hasRule(state.rules[other], a, b)) { toast('두 사람에게 반대 규칙이 있습니다. 그 규칙을 먼저 지우세요.'); return; }
      state.rules[kind].push([a, b]);
      save();
      renderRules();
      renderBoard();
    },
    'remove-rule': function (el) {
      state.rules[el.dataset.kind].splice(Number(el.dataset.index), 1);
      save();
      renderRules();
      renderBoard();
    },
    'pick-member': function (el) {
      if (isConfirmed()) return;
      var id = el.dataset.id;
      if (ui.selected && ui.selected !== id) {
        var teams = state.draft.teams;
        var sameTeam = teams.some(function (t) { return t.indexOf(id) !== -1 && t.indexOf(ui.selected) !== -1; });
        if (!sameTeam) { swapMembers(ui.selected, id); return; }
      }
      ui.selected = ui.selected === id ? null : id;
      renderBoard();
    },
    'drop-team': function (el) {
      if (!ui.selected) return;
      moveMember(ui.selected, Number(el.dataset.team));
    },
    'confirm': function () { confirmDraft(); },
    'unconfirm': function () { unconfirm(); },
    'copy': function () { copyText(resultText()); },
    'print': function () { window.print(); },
    'bulk-add': function () { bulkAdd(); },
    'edit-member': function (el) { editMember(el.dataset.id); },
    'delete-member': function (el) { deleteMember(el.dataset.id); },
    'delete-history': function (el) {
      var id = el.dataset.id;
      ask({
        title: '이 기록을 지울까요?',
        body: '<p>지운 편성은 다음 추첨에 더 이상 반영되지 않습니다.</p>',
        ok: '지우기', danger: true
      }).then(function (ok) {
        if (!ok) return;
        state.history = state.history.filter(function (h) { return h.id !== id; });
        save();
        renderAll();
        toast('기록을 지웠습니다.');
      });
    },
    'export-backup': function () {
      var payload = JSON.stringify({ app: 'TeamShuffle', exportedAt: new Date().toISOString(), data: state }, null, 2);
      saveFile('teamshuffle-backup-' + todayStr() + '.json', payload, 'application/json');
    },
    'export-csv': function () {
      var rows = ['이름,성별,구분'].concat(state.members.slice().sort(byName).map(function (m) {
        return '"' + m.name.replace(/"/g, '""') + '",' + genderText(m.gender) + ',"' + labelOf(m.group).replace(/"/g, '""') + '"';
      }));
      saveFile('teamshuffle-roster-' + todayStr() + '.csv', '\uFEFF' + rows.join('\r\n'), 'text/csv');
    },
    'reset-all': function () {
      ask({
        title: '모든 데이터를 지울까요?',
        body: '<p>명단, 규칙, 이력이 모두 사라지고 되돌릴 수 없습니다.</p>',
        ok: '모두 지우기', danger: true
      }).then(function (ok) {
        if (!ok) return;
        state = defaultState();
        ui.selected = null;
        save();
        renderAll();
        toast('모든 데이터를 지웠습니다.');
      });
    }
  };

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var el = closestEl(e.target, '[data-action]');
      if (!el || !actions[el.dataset.action]) return;
      if (el.disabled) return;
      actions[el.dataset.action](el, e);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.selected && !$('#modal').open) { ui.selected = null; renderBoard(); }
    });

    $('#attendSearch').addEventListener('input', function (e) { ui.search = e.target.value; renderAttendance(); });
    $('#rosterSearch').addEventListener('input', function (e) { ui.rosterSearch = e.target.value; renderRoster(); });
    $('#pairPerson').addEventListener('change', function (e) { ui.pairPerson = e.target.value; renderPairs(); });

    $('#addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#addName').value.trim();
      if (!name) return;
      if (nameTaken(name)) { toast('같은 이름이 이미 있습니다. 구별할 수 있게 적어 주세요.'); return; }
      addMember(name.slice(0, 30), $('input[name="addGender"]:checked').value, $('input[name="addGroup"]:checked').value);
      save();
      renderAll();
      $('#addName').value = '';
      $('#addName').focus();
      toast(name + '님을 추가했습니다.');
    });

    $('#settingsForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var title = $('#setTitle').value.trim() || '팀 랜덤 추첨기';
      var a = $('#setLabelA').value.trim(), b = $('#setLabelB').value.trim();
      if (!a || !b) { toast('두 구분의 이름을 모두 적어 주세요.'); return; }
      if (a === b) { toast('두 구분의 이름은 서로 달라야 합니다.'); return; }
      state.settings.title = title.slice(0, 40);
      state.settings.labelA = a.slice(0, 10);
      state.settings.labelB = b.slice(0, 10);
      state.settings.useHistory = $('#setUseHistory').checked;
      save();
      renderAll();
      toast('설정을 저장했습니다.');
    });

    $('#importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try { parsed = JSON.parse(reader.result); } catch (err) { toast('백업 파일을 읽지 못했습니다. TeamShuffle에서 저장한 .json 파일인지 확인하세요.'); return; }
        var data = parsed && parsed.data ? parsed.data : parsed;
        var next = normalize(data);
        ask({
          title: '백업 파일로 바꿀까요?',
          body: '<p>지금 데이터 대신 백업 파일 내용(명단 ' + next.members.length + '명, 이력 ' + next.history.length + '회)으로 바뀝니다.</p>',
          ok: '불러오기', danger: true
        }).then(function (ok) {
          if (!ok) return;
          state = next;
          ui.selected = null;
          save();
          renderAll();
          toast('백업 파일을 불러왔습니다.');
        });
      };
      reader.readAsText(file, 'utf-8');
    });

    // Drag and drop between teams
    document.addEventListener('dragstart', function (e) {
      var el = closestEl(e.target, '.member');
      if (!el || isConfirmed()) return;
      dragId = el.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      el.classList.add('is-dragging');
    });
    document.addEventListener('dragend', function () {
      dragId = null;
      $$('.is-dragging').forEach(function (el) { el.classList.remove('is-dragging'); });
      $$('.team.is-drop').forEach(function (el) { el.classList.remove('is-drop'); });
    });
    document.addEventListener('dragover', function (e) {
      if (!dragId) return;
      var team = closestEl(e.target, '.team');
      $$('.team.is-drop').forEach(function (el) { if (el !== team) el.classList.remove('is-drop'); });
      if (!team) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      team.classList.add('is-drop');
    });
    document.addEventListener('drop', function (e) {
      if (!dragId) return;
      var team = closestEl(e.target, '.team');
      if (!team) return;
      e.preventDefault();
      var id = dragId;
      dragId = null;
      moveMember(id, Number(team.dataset.team));
    });

    // Modal
    $('#modalOk').addEventListener('click', modalOk);
    $('#modalCancel').addEventListener('click', function () { closeModal(null); });
    $('#modal').addEventListener('cancel', function (e) { e.preventDefault(); closeModal(null); });
    $('.modal-inner').addEventListener('submit', function (e) { e.preventDefault(); modalOk(); });
  }

  load().then(function () {
    bindEvents();
    renderAll();
  });
}());
