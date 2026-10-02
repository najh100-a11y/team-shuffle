/*
 * TeamShuffle balancer
 *
 * Splits people into teams while optimising, in strict priority order:
 *   1. "keep apart" rules are respected
 *   2. men and women are spread evenly across teams
 *   3. team sizes are even
 *   4. the two age groups are spread evenly
 *   5. each gender-and-age combination is spread evenly
 *   6. people who were in the same team before are kept apart where possible
 *
 * "Keep together" rules are always honoured: linked people move as one unit.
 * Lower priorities never trade against higher ones (lexicographic comparison),
 * so team history can never break the gender balance.
 *
 * Works in the browser (window.Balancer) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Balancer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Layout of the count vectors kept per unit and per team.
  var F_SIZE = 0, F_M = 1, F_F = 2, F_A = 3, F_B = 4; // 5..8 = m-a, m-b, f-a, f-b
  var NF = 9;
  // Cost components: 0 keep-apart violations, 1 gender, 2 size, 3 age group, 4 cells, 5 history
  var COMPONENT_FIELDS = [null, [F_M, F_F], [F_SIZE], [F_A, F_B], [5, 6, 7, 8]];
  var NC = 6;

  function pairKey(a, b) {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  /** Count how many times each pair of people shared a team in the given history. */
  function pairCountsFromHistory(history) {
    var counts = Object.create(null);
    (history || []).forEach(function (entry) {
      (entry.teams || []).forEach(function (team) {
        var ids = team.map(function (m) { return typeof m === 'string' ? m : m.id; });
        for (var i = 0; i < ids.length; i++) {
          for (var j = i + 1; j < ids.length; j++) {
            var k = pairKey(ids[i], ids[j]);
            counts[k] = (counts[k] || 0) + 1;
          }
        }
      });
    });
    return counts;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffleInPlace(arr, rand) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function range(n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = i;
    return a;
  }

  function zeros(n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = 0;
    return a;
  }

  function matrix(n, m) {
    var rows = new Array(n);
    for (var i = 0; i < n; i++) rows[i] = zeros(m);
    return rows;
  }

  /** True if the cost delta d is a strict lexicographic improvement. */
  function improves(d) {
    for (var c = 0; c < NC; c++) {
      if (d[c] < 0) return true;
      if (d[c] > 0) return false;
    }
    return false;
  }

  function lexCompare(a, b) {
    for (var c = 0; c < NC; c++) {
      if (a[c] !== b[c]) return a[c] < b[c] ? -1 : 1;
    }
    return 0;
  }

  /**
   * @param {Array<{id:string, gender:'m'|'f', group:'a'|'b'}>} people  present people
   * @param {number} teamCount
   * @param {object} [opts]
   *   pairs:      [[id,id], ...] keep together
   *   separates:  [[id,id], ...] keep apart
   *   pairCounts: {'idA|idB': times together} from history
   *   restarts:   number of independent searches (default 40)
   *   random:     () => number in [0,1)
   * @returns {{teams: string[][], cost: number[], unmetSeparates: Array, impossibleSeparates: Array}}
   */
  function makeTeams(people, teamCount, opts) {
    opts = opts || {};
    var rand = opts.random || Math.random;
    var restarts = Math.max(1, opts.restarts || 40);
    var counts = opts.pairCounts || {};
    var T = Math.floor(teamCount);
    var n = people.length;

    if (!(T >= 1)) throw new Error('팀 수는 1 이상이어야 합니다.');
    if (n < T) throw new Error('출석 인원(' + n + '명)이 팀 수(' + T + '개)보다 적습니다.');

    var index = Object.create(null);
    people.forEach(function (p, i) { index[p.id] = i; });

    // Keep-together rules -> units (union-find)
    var parent = range(n);
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    (opts.pairs || []).forEach(function (pr) {
      var a = index[pr[0]], b = index[pr[1]];
      if (a === undefined || b === undefined) return;
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    });

    var unitOf = new Array(n);
    var units = [];
    var rootToUnit = Object.create(null);
    for (var i = 0; i < n; i++) {
      var r = find(i);
      if (rootToUnit[r] === undefined) { rootToUnit[r] = units.length; units.push([]); }
      unitOf[i] = rootToUnit[r];
      units[rootToUnit[r]].push(i);
    }
    var U = units.length;

    var vec = units.map(function (members) {
      var v = zeros(NF);
      members.forEach(function (pi) {
        var p = people[pi];
        var male = p.gender === 'm';
        var ga = p.group === 'a';
        v[F_SIZE] += 1;
        v[male ? F_M : F_F] += 1;
        v[ga ? F_A : F_B] += 1;
        v[5 + (male ? 0 : 2) + (ga ? 0 : 1)] += 1;
      });
      return v;
    });

    // History weight between units: sum over member pairs of (times together)^2.
    // Squaring spreads repeats out: two pairs that met once beat one pair meeting a third time.
    var W = matrix(U, U);
    for (var x = 0; x < n; x++) {
      for (var y = x + 1; y < n; y++) {
        var ux = unitOf[x], uy = unitOf[y];
        if (ux === uy) continue;
        var c = counts[pairKey(people[x].id, people[y].id)] || 0;
        if (c > 0) { W[ux][uy] += c * c; W[uy][ux] += c * c; }
      }
    }

    // Keep-apart rules between units
    var S = matrix(U, U);
    var impossible = [];
    var activeSeparates = [];
    (opts.separates || []).forEach(function (pr) {
      var a = index[pr[0]], b = index[pr[1]];
      if (a === undefined || b === undefined) return;
      var ua = unitOf[a], ub = unitOf[b];
      if (ua === ub) { impossible.push([pr[0], pr[1]]); return; }
      S[ua][ub] += 1; S[ub][ua] += 1;
      activeSeparates.push([pr[0], pr[1]]);
    });

    var best = null;
    var bestTeamOf = null;

    for (var rs = 0; rs < restarts; rs++) {
      var run = searchOnce();
      if (best === null || lexCompare(run.cost, best) < 0) {
        best = run.cost;
        bestTeamOf = run.teamOf;
      }
    }

    var teams = [];
    for (var t = 0; t < T; t++) teams.push([]);
    for (var u = 0; u < U; u++) {
      units[u].forEach(function (pi) { teams[bestTeamOf[u]].push(people[pi].id); });
    }
    shuffleInPlace(teams, rand); // team numbers carry no meaning

    var teamIndexOf = Object.create(null);
    teams.forEach(function (tm, ti) { tm.forEach(function (id) { teamIndexOf[id] = ti; }); });
    var unmet = activeSeparates.filter(function (pr) {
      return teamIndexOf[pr[0]] === teamIndexOf[pr[1]];
    });

    return {
      teams: teams,
      cost: best,
      unmetSeparates: unmet,
      impossibleSeparates: impossible
    };

    function searchOnce() {
      var teamOf = new Array(U);
      var agg = matrix(T, NF);
      var histTo = matrix(U, T);
      var sepTo = matrix(U, T);
      var d = zeros(NC);

      function assign(u, t) {
        teamOf[u] = t;
        for (var f = 0; f < NF; f++) agg[t][f] += vec[u][f];
        for (var k = 0; k < U; k++) { histTo[k][t] += W[k][u]; sepTo[k][t] += S[k][u]; }
      }
      function unassign(u, t) {
        for (var f = 0; f < NF; f++) agg[t][f] -= vec[u][f];
        for (var k = 0; k < U; k++) { histTo[k][t] -= W[k][u]; sepTo[k][t] -= S[k][u]; }
      }
      function move(u, from, to) { unassign(u, from); assign(u, to); }

      // Cost change of adding unit u to team t (used while building the start)
      function addDelta(u, t, out) {
        out[0] = sepTo[u][t];
        for (var c = 1; c <= 4; c++) {
          var s = 0, fs = COMPONENT_FIELDS[c];
          for (var q = 0; q < fs.length; q++) {
            var a = agg[t][fs[q]], v = vec[u][fs[q]];
            s += (a + v) * (a + v) - a * a;
          }
          out[c] = s;
        }
        out[5] = histTo[u][t];
      }

      function moveDelta(u, A, B, out) {
        out[0] = sepTo[u][B] - sepTo[u][A];
        for (var c = 1; c <= 4; c++) {
          var s = 0, fs = COMPONENT_FIELDS[c];
          for (var q = 0; q < fs.length; q++) {
            var f = fs[q], a = agg[A][f], b = agg[B][f], v = vec[u][f];
            s += (a - v) * (a - v) - a * a + (b + v) * (b + v) - b * b;
          }
          out[c] = s;
        }
        out[5] = histTo[u][B] - histTo[u][A];
      }

      function swapDelta(u, v, out) {
        var A = teamOf[u], B = teamOf[v];
        out[0] = (sepTo[u][B] - S[u][v]) - sepTo[u][A] + (sepTo[v][A] - S[v][u]) - sepTo[v][B];
        for (var c = 1; c <= 4; c++) {
          var s = 0, fs = COMPONENT_FIELDS[c];
          for (var q = 0; q < fs.length; q++) {
            var f = fs[q], a = agg[A][f], b = agg[B][f], dx = vec[v][f] - vec[u][f];
            s += (a + dx) * (a + dx) - a * a + (b - dx) * (b - dx) - b * b;
          }
          out[c] = s;
        }
        out[5] = (histTo[u][B] - W[u][v]) - histTo[u][A] + (histTo[v][A] - W[u][v]) - histTo[v][B];
      }

      // Greedy start: biggest units first, each placed where it costs least (random tie-break)
      var order = shuffleInPlace(range(U), rand);
      order.sort(function (p, q) { return vec[q][F_SIZE] - vec[p][F_SIZE]; });
      var tmp = zeros(NC);
      order.forEach(function (u) {
        var bestT = -1, bestD = null, ties = 0;
        for (var t = 0; t < T; t++) {
          addDelta(u, t, tmp);
          var cmp = bestD === null ? -1 : lexCompare(tmp, bestD);
          if (cmp < 0) { bestT = t; bestD = tmp.slice(); ties = 1; }
          else if (cmp === 0) { ties++; if (rand() * ties < 1) bestT = t; }
        }
        assign(u, bestT);
      });

      // Local search: single moves and pairwise swaps, accept strict improvements only
      var passes = 0, improved = true;
      while (improved && passes < 200) {
        improved = false;
        passes++;
        var uorder = shuffleInPlace(range(U), rand);
        for (var i1 = 0; i1 < U; i1++) {
          var u = uorder[i1];
          var torder = shuffleInPlace(range(T), rand);
          for (var ti = 0; ti < T; ti++) {
            var B = torder[ti], A = teamOf[u];
            if (B === A) continue;
            moveDelta(u, A, B, d);
            if (improves(d)) { move(u, A, B); improved = true; }
          }
        }
        for (var a1 = 0; a1 < U; a1++) {
          for (var b1 = a1 + 1; b1 < U; b1++) {
            var uu = uorder[a1], vv = uorder[b1];
            if (teamOf[uu] === teamOf[vv]) continue;
            swapDelta(uu, vv, d);
            if (improves(d)) {
              var Au = teamOf[uu], Bv = teamOf[vv];
              move(uu, Au, Bv);
              move(vv, Bv, Au);
              improved = true;
            }
          }
        }
      }

      return { teamOf: teamOf.slice(), cost: fullCost() };

      function fullCost() {
        var cost = zeros(NC);
        for (var t = 0; t < T; t++) {
          for (var c = 1; c <= 4; c++) {
            var fs = COMPONENT_FIELDS[c];
            for (var q = 0; q < fs.length; q++) cost[c] += agg[t][fs[q]] * agg[t][fs[q]];
          }
        }
        for (var p = 0; p < U; p++) {
          cost[0] += sepTo[p][teamOf[p]];
          cost[5] += histTo[p][teamOf[p]];
        }
        cost[0] /= 2; // each pair counted from both sides
        cost[5] /= 2;
        return cost;
      }
    }
  }

  /**
   * Summarise a team layout for display and checks.
   * @param {string[][]} teams  member ids per team
   * @param {Object<string,{gender:string, group:string}>} byId
   * @param {object} [counts]  pair counts from history
   */
  function describe(teams, byId, counts) {
    counts = counts || {};
    var perTeam = teams.map(function (ids) {
      var s = { size: 0, m: 0, f: 0, a: 0, b: 0, repeatPairs: 0 };
      ids.forEach(function (id) {
        var p = byId[id];
        if (!p) return;
        s.size++;
        if (p.gender === 'm') s.m++; else s.f++;
        if (p.group === 'a') s.a++; else s.b++;
      });
      for (var i = 0; i < ids.length; i++) {
        for (var j = i + 1; j < ids.length; j++) {
          if (counts[pairKey(ids[i], ids[j])]) s.repeatPairs++;
        }
      }
      return s;
    });
    function spread(key) {
      var vals = perTeam.map(function (s) { return s[key]; });
      return { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
    }
    return {
      perTeam: perTeam,
      size: spread('size'), m: spread('m'), f: spread('f'), a: spread('a'), b: spread('b')
    };
  }

  return {
    makeTeams: makeTeams,
    describe: describe,
    pairKey: pairKey,
    pairCountsFromHistory: pairCountsFromHistory,
    mulberry32: mulberry32
  };
}));
