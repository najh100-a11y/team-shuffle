/* Run with: npm test */
'use strict';
const assert = require('assert');
const B = require('../app/balancer.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function makePeople(spec, rand) {
  // spec: {ma, mb, fa, fb}
  const out = [];
  let k = 0;
  const add = (g, grp, cnt) => { for (let i = 0; i < cnt; i++) out.push({ id: 'p' + (k++), gender: g, group: grp }); };
  add('m', 'a', spec.ma); add('m', 'b', spec.mb); add('f', 'a', spec.fa); add('f', 'b', spec.fb);
  if (rand) { for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } }
  return out;
}
const byIdOf = (people) => Object.fromEntries(people.map(p => [p.id, p]));
const spread = (s) => s.max - s.min;

console.log('Balancer tests');

check('every present person is placed exactly once', () => {
  const rand = B.mulberry32(1);
  const people = makePeople({ ma: 8, mb: 7, fa: 8, fb: 6 }, rand);
  const r = B.makeTeams(people, 4, { random: rand });
  const ids = r.teams.flat().sort();
  assert.deepStrictEqual(ids, people.map(p => p.id).sort());
  assert.strictEqual(r.teams.length, 4);
});

check('keep-together rules always hold (including chains)', () => {
  for (let s = 0; s < 200; s++) {
    const rand = B.mulberry32(100 + s);
    const people = makePeople({ ma: 6, mb: 5, fa: 6, fb: 5 }, rand);
    const pairs = [[people[0].id, people[1].id], [people[1].id, people[2].id], [people[5].id, people[9].id]];
    const r = B.makeTeams(people, 4, { random: rand, pairs });
    const teamOf = {};
    r.teams.forEach((t, i) => t.forEach(id => { teamOf[id] = i; }));
    pairs.forEach(([a, b]) => assert.strictEqual(teamOf[a], teamOf[b], 'pair split in seed ' + s));
  }
});

check('keep-apart rules hold whenever they can', () => {
  for (let s = 0; s < 200; s++) {
    const rand = B.mulberry32(500 + s);
    const people = makePeople({ ma: 6, mb: 5, fa: 6, fb: 5 }, rand);
    const seps = [[people[0].id, people[1].id], [people[2].id, people[3].id], [people[0].id, people[4].id]];
    const r = B.makeTeams(people, 3, { random: rand, separates: seps });
    assert.strictEqual(r.unmetSeparates.length, 0, 'unmet in seed ' + s);
  }
});

check('contradictory rules are reported, not silently ignored', () => {
  const people = makePeople({ ma: 3, mb: 3, fa: 3, fb: 3 });
  const r = B.makeTeams(people, 3, {
    pairs: [[people[0].id, people[1].id]],
    separates: [[people[0].id, people[1].id]]
  });
  assert.strictEqual(r.impossibleSeparates.length, 1);
});

check('too few people throws a clear error', () => {
  assert.throws(() => B.makeTeams(makePeople({ ma: 1, mb: 0, fa: 1, fb: 0 }), 3), /적습니다/);
});

// Balance guarantees on random groups without rules
const TRIALS = 2000;
let ran = 0, genderOk = 0, sizeOk = 0, groupOk = 0, allOk = 0;
for (let s = 0; s < TRIALS; s++) {
  const rand = B.mulberry32(10000 + s);
  const spec = {
    ma: Math.floor(rand() * 15), mb: Math.floor(rand() * 15),
    fa: Math.floor(rand() * 15), fb: Math.floor(rand() * 15)
  };
  const people = makePeople(spec, rand);
  if (people.length < 4) continue;
  const T = 2 + Math.floor(rand() * Math.min(7, Math.floor(people.length / 2) - 1 || 1));
  if (people.length < T) continue;
  ran++;
  const r = B.makeTeams(people, T, { random: rand });
  const d = B.describe(r.teams, byIdOf(people));
  const g = spread(d.m) <= 1 && spread(d.f) <= 1;
  const z = spread(d.size) <= 1;
  const a = spread(d.a) <= 1 && spread(d.b) <= 1;
  if (g) genderOk++;
  if (z) sizeOk++;
  if (a) groupOk++;
  if (g && z && a) allOk++;
}
check('men and women spread within 1 per team in every random case', () => {
  assert.strictEqual(genderOk, ran, `${ran - genderOk} of ${ran} cases unbalanced`);
});
check('team sizes within 1 in every random case', () => {
  assert.strictEqual(sizeOk, ran, `${ran - sizeOk} of ${ran} cases uneven`);
});
console.log(`       ${ran} random groups; age groups within 1: ${groupOk}/${ran}, all three at once: ${allOk}/${ran}`);

check('history is used to mix people without breaking gender balance', () => {
  const rand = B.mulberry32(77);
  const people = makePeople({ ma: 8, mb: 7, fa: 8, fb: 6 }, rand);
  const byId = byIdOf(people);
  const history = [];
  let repeatsLate = 0;
  for (let session = 0; session < 12; session++) {
    const present = people.filter(() => rand() < 0.85);
    const counts = B.pairCountsFromHistory(history);
    const r = B.makeTeams(present, 4, { random: rand, pairCounts: counts });
    const d = B.describe(r.teams, byId, counts);
    assert.ok(spread(d.m) <= 1 && spread(d.f) <= 1, 'gender broke in session ' + session);
    assert.ok(spread(d.size) <= 1, 'size broke in session ' + session);
    if (session >= 1 && session <= 3) repeatsLate += d.perTeam.reduce((s, t) => s + t.repeatPairs, 0);
    history.push({ teams: r.teams });
  }
  // Sessions 2-4 should rarely repeat pairs from earlier sessions
  console.log(`       repeated pairs in sessions 2-4: ${repeatsLate}`);
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll tests passed');
