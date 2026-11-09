import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { runInThisContext } from 'node:vm';
import { symbolicateFrames } from './source-maps.mjs';
import { frameKey } from './analysis.mjs';

test('real CDP parsed scripts retain their embedded maps across same-URL reloads', async () => {
  const session = new Session(), scripts = new Map();
  const url = 'https://fixture.invalid/bundle.js';
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => { if (params.url === url) scripts.set(params.scriptId, params); });
  try {
    await new Promise((resolve, reject) => session.post('Debugger.enable', error => error ? reject(error) : resolve()));
    for (const [source, base64] of [['src/Original.ts', true], ['src/Newer.ts', false]]) {
      const json = JSON.stringify({ version: 3, sources: [source], names: ['owner'], mappings: 'AAAAA' });
      const map = base64 ? 'data:application/json;base64,' + Buffer.from(json).toString('base64')
        : 'data:application/json,' + encodeURIComponent(json);
      runInThisContext(`(function generatedOwner() { return 1; })\n//# sourceMappingURL=${map}`, { filename: url })();
    }
    assert.equal(scripts.size, 2);
    const [original, newer] = [...scripts.values()];
    assert.notEqual(original.hash, newer.hash);
    const frames = [...scripts.keys()].map(scriptId => ({ scriptId, url, functionName: 'generatedOwner', lineNumber: 0, columnNumber: 0 }));
    const { symbols, attribution } = symbolicateFrames(frames, scripts);
    assert.equal(symbols.get(frameKey(frames[0])).source, 'src/Original.ts');
    assert.equal(symbols.get(frameKey(frames[1])).source, 'src/Newer.ts');
    assert.deepEqual(attribution.mapFailures, []);
    assert.equal(attribution.scriptMaps[0].hash, original.hash);
    assert.equal(attribution.scriptMaps[0].length, original.length);
    assert.equal(attribution.scriptMaps[0].pairing, 'cdp-inline-source-map');
  } finally { session.disconnect(); }
});

test('unproven or invalid maps leave generated frames available with a visible reason', () => {
  const url = 'https://fixture.invalid/bundle.js?token=never-save';
  const scripts = new Map([
    ['external', { url, sourceMapURL: '/bundle.map?token=never-save', hash: 'loaded-hash', length: 42 }],
    ['invalid', { url, sourceMapURL: 'data:application/json;base64,bm90LWpzb24=' }],
    ['absent', { url }],
  ]);
  const frames = ['external', 'invalid', 'absent', 'unknown', '0'].map(scriptId => ({ scriptId, url, functionName: 'generatedOwner', lineNumber: 0, columnNumber: 0 }));
  const { symbols, attribution } = symbolicateFrames(frames, scripts);
  assert.equal(symbols.size, 0);
  assert.deepEqual(attribution.mapFailures.map(row => [row.scriptId, row.reason]), [
    ['external', 'external-map-pairing-unproven'], ['invalid', 'inline-map-invalid'],
    ['absent', 'source-map-unavailable'], ['unknown', 'script-identity-unavailable'],
  ]);
  assert.equal(attribution.mapFailures[0].hash, 'loaded-hash');
  assert.equal(attribution.mapFailures[0].length, 42);
  assert.ok(!JSON.stringify(attribution).includes('never-save'));
});
