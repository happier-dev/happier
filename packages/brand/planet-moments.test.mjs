import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as moments from './planet-moments.mjs';
import { createPlanetScene } from './planet.mjs';
import { assertStructuralParity, captureRuntimeSkip } from './scripts/parityAssertions.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/planet-moments-parity.json', import.meta.url), 'utf8'));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// The immutable capture describes the former partial look. Replay only those authored inputs in
// memory to continue testing extracted choreography, separately from the corrected product look.
// No historical fixture is regenerated and no legacy look mode enters the product API.
const historicalSource = readFileSync(new URL('./planet-moments.mjs', import.meta.url), 'utf8')
  .replace("from './planet.mjs'", `from '${new URL('./planet.mjs', import.meta.url).href}'`)
  .replace('...o, ...PAIRING_PLANET_LOOK, field: 0', '...o, field: 0')
  .replace('planetCollapseCells({ R, theme: th })', 'planetCollapseCells({ R, theme: th, pitch: Math.max(2.6, Q.cell * 0.82) })')
  .replace('const look = PAIRING_PLANET_LOOK;', 'const look = { pitch: 2, dot: 0.72, jitter: 0.6 };')
  .replace('const look = { ...PAIRING_PLANET_LOOK, field: 0.9 };', 'const look = { field: 0.9 };');
const capturedLook = await import(`data:text/javascript;base64,${Buffer.from(historicalSource).toString('base64')}`);
test('QR scan and pairing paint the same full Balanced fine-pitch scene and fold targets', () => {
  for (const theme of ['light', 'dark']) for (const dpr of [1, 2]) {
    const size = 224;
    const Q = moments.qrMomentModel(fixture.matrices[0], size, dpr);
    const scan = moments.qrMomentFrame(Q, 0.9, { size, theme, phase: 'scan' });
    const pair = moments.pairingMomentFrame(0, { w: size, h: size, theme, layout: 'square', phase: 'handoff' });
    for (const commands of [scan.commands, pair]) {
      const options = commands.find(([kind]) => kind === 'planet')[1];
      const actual = createPlanetScene({ ...options, dpr, view: { w: size, h: size } });
      const expected = createPlanetScene({ ...options, fullness: 1, style: 'balanced', pitch: 2, dpr, view: { w: size, h: size } });
      assert.equal(digest(actual), digest(expected), `${theme}/${dpr}: rendered scene`);
      assert.equal('dot' in options || 'jitter' in options, false);
    }
    const targets = moments.planetCollapseCells({ R: size * 0.29, theme });
    const R = size * 0.29;
    const extent = Math.ceil(R * 1.1);
    const body = createPlanetScene({ R, cx: extent, cy: extent, view: { w: extent * 2, h: extent * 2 }, theme, fullness: 1, style: 'balanced', pitch: 2, field: 0 }).body;
    const expected = body.map((d) => ({ x: d.x - extent, y: d.y - extent, e: 1, col: d.rgb, i: d.i + 4096, j: d.j + 4096, r: Math.hypot((d.x - extent) / R, (d.y - extent) / R) }));
    assert.equal(digest(targets), digest(expected), `${theme}/${dpr}: collapse silhouette and density`);
    const prepared = moments.qrMomentFrame(Q, 0.32, { size, theme, phase: 'scan', collapseTargets: targets });
    assert.deepEqual(prepared, moments.qrMomentFrame(Q, 0.32, { size, theme, phase: 'scan' }));
  }
});
test('QR module-input models preserve captured structure and identities', async (t) => {
  const hashes = [];
  for (const f of fixture.models) {
    const actual = moments.qrMomentModel(f.matrix, f.S, f.dpr);
    const label = `${f.S}/${f.dpr}/${f.matrix.text}`;
    if (f.output) assertStructuralParity(actual, f.output, label);
    hashes.push([digest(actual), f.sha256, label]);
  }
  await t.test('QR model exact hashes match the capture', { skip: captureRuntimeSkip }, () => {
    for (const [actual, expected, label] of hashes) assert.equal(actual, expected, label);
  });
});
test('QR, pairing, Horizon and ripple frames preserve captured structure and timings', async (t) => {
  const models = new Map();
  const hashes = [];
  for (const f of fixture.frames) {
    let output;
    if (f.moment === 'qr') {
      const model = (text) => {
        const key = `${text}|${f.w}|${f.options.dpr}`;
        if (!models.has(key)) models.set(key, moments.qrMomentModel(fixture.matrices.find((m) => m.text === text), f.w, f.options.dpr));
        return models.get(key);
      };
      output = { commands: capturedLook.qrMomentFrame(model(f.options.text), f.time, { ...f.options, size: f.w, next: model(f.options.next) }).commands, styles: [{}, {}] };
    } else if (f.moment === 'pair') {
      output = { commands: capturedLook.pairingMomentFrame(f.time, { ...f.options, w: f.w, h: f.h }), styles: [{}, {}] };
    } else if (f.moment === 'theme') {
      const frame = moments.themeSwitchFrame(f.time, { ...f.options, w: f.w, h: f.h });
      const top = { zIndex: 2, clipPath: frame.clipPath, visibility: frame.visibility }, bot = { zIndex: 1 };
      output = { commands: frame.commands, styles: f.options.dir === 'sunrise' ? [top, bot] : [bot, top] };
    } else {
      const frame = moments.sessionFinishedRippleFrame(f.time, { ...f.options, w: f.w, h: f.h });
      output = { commands: [['planet', frame.planet], ...(frame.ringProgress === null ? [['clearRect', 0, 0, null, null]] : [['ripple', { x: frame.planet.cx, y: frame.planet.cy, theme: f.options.theme, pageColor: undefined, radius: 230, freeze: frame.ringProgress }]])], styles: [{}, {}] };
    }
    const label = `${f.moment}/${JSON.stringify(f.options)}/${f.time}`;
    if (f.output) assertStructuralParity(output, f.output, label);
    hashes.push([digest(output), f.sha256, label]);
  }
  assert.deepEqual(moments.FURTHER_PLANET_MOMENT_TIMINGS.QR, fixture.timings.QR);
  assert.deepEqual(moments.FURTHER_PLANET_MOMENT_TIMINGS.SCAN, fixture.timings.SCAN);
  assert.deepEqual(moments.FURTHER_PLANET_MOMENT_TIMINGS.PAIR, fixture.timings.PAIR);
  assert.equal(moments.FURTHER_PLANET_MOMENT_TIMINGS.TH.DUR, 1.2);
  assert.equal(moments.FURTHER_PLANET_MOMENT_TIMINGS.RIP.DUR, 1.6);
  await t.test('moment command exact hashes match the capture', { skip: captureRuntimeSkip }, () => {
    for (const [actual, expected, label] of hashes) assert.equal(actual, expected, label);
  });
});
test('finish policy admits only a newly finished visible turn without approval, merging the eight-second window', () => {
  let now = 100; let last = null;
  const decide = (overrides = {}) => {
    const decision = moments.sessionFinishedRippleTrigger({ nowMs: now, lastTriggeredAtMs: last, wasFinished: false, turnComplete: true, pendingApproval: false, homeVisible: true, ...overrides });
    last = decision.lastTriggeredAtMs; return decision.trigger;
  };
  assert.equal(decide({ turnComplete: false }), false);
  assert.equal(decide({ pendingApproval: true }), false);
  assert.equal(decide({ homeVisible: false }), false);
  assert.equal(decide({ wasFinished: true }), false);
  assert.equal(last, null);
  assert.equal(decide(), true);
  now = 8099; assert.equal(decide(), false); assert.equal(last, 100);
  now = 8100; assert.equal(decide(), true);
  now = 16100; assert.equal(decide({ wasFinished: true }), false);
  assert.equal(decide(), true);
});
test('held QR readiness follows the newly assembled payload, and sampling never mutates prepared models or collapse targets', () => {
  const Q = moments.qrMomentModel(fixture.matrices[0], 224, 2);
  const next = moments.qrMomentModel(fixture.matrices[1], 224, 2);
  const options = { size: 224, theme: 'light' };
  assert.equal(moments.qrMomentFrame(Q, 0.919, options).held, null);
  assert.equal(moments.qrMomentFrame(Q, 0.92, options).held, Q.text);
  const reform = { ...options, phase: 'reform', next, wait: 0.25 };
  assert.equal(moments.qrMomentFrame(Q, 1.489, reform).held, null);
  assert.equal(moments.qrMomentFrame(Q, 1.5, reform).held, next.text);
  const targets = moments.planetCollapseCells({ R: 224 * 0.29, theme: 'light' });
  const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(Q); freeze(targets);
  const scan = { ...options, phase: 'scan', collapseTargets: targets };
  const first = moments.qrMomentFrame(Q, 0.5, scan);
  moments.qrMomentFrame(Q, 0.8, scan);
  assert.deepEqual(moments.qrMomentFrame(Q, 0.5, scan), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.held, null);
});
test('resettle policy runs only idle and visible, without extending the hourly window on rejected checks', () => {
  let now = 0; let last = null;
  const decide = (overrides = {}) => {
    const decision = moments.idleResettleTrigger({ nowMs: now, lastTriggeredAtMs: last, homeIdle: true, homeVisible: true, ...overrides });
    last = decision.lastTriggeredAtMs; return decision.trigger;
  };
  assert.equal(decide({ homeIdle: false }), false);
  assert.equal(decide({ homeVisible: false }), false);
  assert.equal(last, null);
  assert.equal(decide(), true);
  now = 3599999; assert.equal(decide(), false); assert.equal(last, 0);
  now = 3600000; assert.equal(decide({ homeIdle: false }), false);
  assert.equal(decide({ homeVisible: false }), false);
  assert.equal(decide(), true);
  assert.equal(moments.FURTHER_PLANET_MOMENT_TIMINGS.RESETTLE.DUR, 1.8);
});
test('the trigger windows the policies enforce are the exported windows', () => {
  const { ripple, resettle } = moments.MOMENT_TRIGGER_WINDOWS_MS;
  const rip = (nowMs) => moments.sessionFinishedRippleTrigger({ nowMs, lastTriggeredAtMs: 0, wasFinished: false, turnComplete: true, pendingApproval: false, homeVisible: true }).trigger;
  const settle = (nowMs) => moments.idleResettleTrigger({ nowMs, lastTriggeredAtMs: 0, homeIdle: true, homeVisible: true }).trigger;
  assert.deepEqual([rip(ripple - 1), rip(ripple), settle(resettle - 1), settle(resettle)], [false, true, false, true]);
});
test('the theme switch digits take the destination ink they are given, and leave the alpha as they found it', () => {
  for (const dir of ['sunrise', 'night']) {
    const { commands } = moments.themeSwitchFrame(0.6, { w: 390, h: 844, dir, kind: 'horizon', ink: '#f2efe9' });
    let fill = null, alpha = 1, texts = 0;
    for (const [kind, key, value] of commands) {
      if (kind === 'set' && key === 'fillStyle') fill = value;
      if (kind === 'set' && key === 'globalAlpha') alpha = value;
      if (kind === 'fillText') { texts++; assert.equal(fill, '#f2efe9'); assert.ok(alpha > 0 && alpha <= 1); }
    }
    assert.ok(texts > 0);
    assert.equal(alpha, 1);
  }
});
