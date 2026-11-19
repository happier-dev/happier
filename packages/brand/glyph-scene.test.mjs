import assert from 'node:assert/strict';
import test from 'node:test';

import { glyphFrame, planetGlyphLayer, travellerGlyphLayer, frontGlyphLayer } from './glyph-scene.mjs';
import { horizonPlanetGeometry } from './planet-placement.mjs';

const view = { w: 390, h: 844 };
const render = (layers, time = 0) => glyphFrame({ view, dpr: 1.5, theme: 'dark', layers }, { time });

test('Horizon follows the composer and stops at the visual foot', () => {
    for (const height of [640, 844, 1100]) {
        const composerTop = height / 3;
        const geometry = horizonPlanetGeometry({ width: 390, height }, { phone: true, composerTop });
        assert.equal(geometry.limb, composerTop + 10);
        assert.ok(Math.abs(geometry.cy - geometry.R - geometry.limb) < 1e-9);
        const layer = planetGlyphLayer({ geometry, intensity: 'quiet', digits: true, fade: { from: 525, to: 615 } });
        const frame = render([layer]);
        assert.deepEqual(frame, render([layer]));
        assert.ok(frame.sprites.glyph.length > 0);
        for (let i = 1; i < frame.sprites.at.length; i += 2) assert.ok(frame.sprites.at[i] < 615 * 1.5);
        assert.deepEqual(frame.body.fade, { from: 525 * 1.5, to: 615 * 1.5 });
    }
});

test('a settled planet is byte equal to the static frame at its selected intensity', () => {
    const geometry = horizonPlanetGeometry({ width: 390, height: 844 }, { phone: true, composerTop: 290 });
    const planet = { geometry, intensity: 'calm', digits: false };
    assert.notDeepEqual(render([planetGlyphLayer(planet)]), render([planetGlyphLayer({ ...planet, settle: { durationS: 2 } })], 0));
    assert.deepEqual(render([planetGlyphLayer(planet)]), render([planetGlyphLayer({ ...planet, settle: { durationS: 2 } })], 2));
});

test('the Loading front decodes into the same planet at its selected intensity', () => {
    const geometry = horizonPlanetGeometry({ width: 390, height: 844 }, { phone: true, composerTop: 290 });
    const layer = planetGlyphLayer({ geometry, intensity: 'full', digits: true });
    const resting = render([layer]);
    const decoding = render([{ ...layer, decode: 0.4 }]);
    const alpha = (frame) => frame.body.rgba.filter((value, index) => index % 4 === 3 && value > 0).length;
    assert.ok(alpha(decoding) > 0 && alpha(decoding) < alpha(resting));
    assert.deepEqual(render([{ ...layer, decode: 1 }]), resting);
});

test('travellers land at the specified endpoint and fronts sample deterministically', () => {
    const particle = travellerGlyphLayer({ particles: new Float32Array([4, 8, 84, 120, 0.5, 1, 16, 0]), ink: [200, 100, 50, 255] });
    const front = frontGlyphLayer({ shape: 'roundRect', rect: { x: 0, y: 0, width: 80, height: 90 }, front: 48, band: 16, ragged: 8, alpha: 1, ink: [200, 100, 50, 255], mode: 'eat' });
    assert.deepEqual(Array.from(render([particle], 1.5).sprites.at), [126, 180]);
    assert.deepEqual(render([front], 0.12), render([front], 0.12));
});

test('the dot field keeps its stipple as its mask calms, and keeps copy clear', async () => {
    const { fieldDotLayer, glyphFieldDurationS } = await import('./glyph-scene.mjs');
    const options = { mode: 'animated', quiet: [{ x: 0, y: 0, width: 390, height: 200, level: 0.1, feather: 30 }], seed: 23 };
    const layer = fieldDotLayer(options);
    const active = render([layer], 1).field;
    const settled = render([layer], glyphFieldDurationS).field;
    assert.deepEqual(active.sprites, settled.sprites);
    assert.notDeepEqual(active.mask.rgba, settled.mask.rgba);
    assert.deepEqual(settled, render([layer], 20).field);
    assert.ok(settled.mask.rgba[3] < 26);
    assert.equal(render([fieldDotLayer({ ...options, mode: 'off' })]).field, null);
});

test('expired pointer and click ink leave the settled mask and its texture alone', async () => {
    const { createGlyphFrameSampler, fieldDotLayer } = await import('./glyph-scene.mjs');
    const sample = createGlyphFrameSampler();
    const stamps = { stirs: [{ x: 42, y: 42, at: 0 }], ripples: [{ x: 42, y: 42, at: 0 }] };
    const fieldAt = (time, options) => sample({ view, dpr: 1, theme: 'dark',
        layers: [fieldDotLayer({ mode: 'animated', ...options })] }, { time }).field;
    const stirred = fieldAt(0.08, stamps).mask.rgba.slice();
    assert.notDeepEqual(stirred, fieldAt(0.08, {}).mask.rgba);
    const settled = fieldAt(5, stamps);
    assert.strictEqual(settled, fieldAt(10, stamps));
    assert.deepEqual(settled, fieldAt(10, {}));
});
