import assert from 'node:assert/strict';
import test from 'node:test';

import { glyphFrame, planetGlyphLayer, travellerGlyphLayer, frontGlyphLayer, markGlyphLayer } from './glyph-scene.mjs';
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

test('opening mark cells lock and depart on the same times their travellers are authored against', () => {
    const layer = markGlyphLayer({ centre: { x: 120, y: 120 }, size: 108, ink: 'sunrise',
        cellTimeline: new Float32Array([120, 126, 0.5, 1.25, 144, 148, 0.75, 1.5]) });
    assert.deepEqual(Array.from(render([layer], 0.49).sprites.at), []);
    assert.deepEqual(Array.from(render([layer], 0.5).sprites.at), [180, 189]);
    assert.deepEqual(Array.from(render([layer], 0.75).sprites.at), [180, 189, 216, 222]);
    assert.deepEqual(Array.from(render([layer], 1.25).sprites.at), [216, 222]);
    assert.deepEqual(Array.from(render([layer], 1.5).sprites.at), []);
    const turned = render([{ ...layer, turn: 1 }], 1.25);
    assert.ok(turned.sprites.at[0] < 216 && turned.sprites.at[0] > 180);
    assert.equal(turned.sprites.at[1], 222);
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

test('the Home planet is the glyph planet: light-ramp cells over a faint wash, sparse ink digits, intensity as opacity', async () => {
    const { glyphRampFirstTile, glyphRampChars, glyphPlanetDigitFirstTile } = await import('./glyph-scene.mjs');
    const { PLANET_PALETTES } = await import('./planet.mjs');
    const pane = { width: 1056, height: 852 };
    const geometry = horizonPlanetGeometry(pane, { composerTop: 386 });
    const frameAt = (intensity, digits = true) => glyphFrame({ view: { w: pane.width, h: pane.height }, dpr: 1, theme: 'light',
        layers: [planetGlyphLayer({ geometry, intensity, digits, fade: { from: 600, to: 720 } })] });
    const isRamp = (g) => g >= glyphRampFirstTile && g < glyphRampFirstTile + glyphRampChars.length;
    const full = frameAt('full');
    const glyphs = [...full.sprites.glyph];
    const isDigit = (g) => g >= glyphPlanetDigitFirstTile && g < glyphPlanetDigitFirstTile + 10;
    const ramp = glyphs.filter(isRamp).length, digits = glyphs.filter(isDigit).length;
    let disc = 0;
    for (let y = 8; y < 600; y += 16) for (let x = 4; x < pane.width; x += 8) if (Math.hypot(x - geometry.cx, y - geometry.cy) < geometry.R) disc++;
    assert.ok(ramp > 0.4 * disc, `ramp cells ${ramp} of ${disc} disc cells`);
    assert.ok(digits > 0.2 * ramp && digits < 0.6 * ramp, `digits ${digits} for ${ramp} ramp cells`);
    const background = PLANET_PALETTES.light.background;
    for (let i = 0; i < full.sprites.glyph.length; i++) {
        if (!isDigit(full.sprites.glyph[i])) continue;
        const rgb = [...full.sprites.rgba.subarray(i * 4, i * 4 + 3)];
        assert.notDeepEqual(rgb, [...background], 'Home digits are ink, not cut-outs');
    }
    let wash = 0;
    for (let i = 3; i < full.body.rgba.length; i += 4) wash = Math.max(wash, full.body.rgba[i]);
    assert.ok(wash > 0 && wash <= Math.round(255 * 0.16) + 1, `body wash ${wash}`);
    // Quiet is the same planet at 0.42 opacity (its halo also glows less, so compare the cells both draw).
    const quiet = frameAt('quiet');
    const alphas = (frame) => new Map(Array.from(frame.sprites.glyph, (g, i) => [`${frame.sprites.at[i * 2]}/${frame.sprites.at[i * 2 + 1]}/${g}`, frame.sprites.rgba[i * 4 + 3]]));
    const quietAlpha = alphas(quiet);
    let q = 0, f = 0;
    for (const [key, alpha] of alphas(full)) if (quietAlpha.has(key)) { q += quietAlpha.get(key); f += alpha; }
    assert.ok(f > 0 && Math.abs(q / f - 0.42) < 0.03, `Quiet/Full opacity ${q / f}`);
    assert.equal([...frameAt('full', false).sprites.glyph].filter(isDigit).length, 0);
});

test('the Home field is patchy, gives way around the planet and follows the intensity strength', async () => {
    const { fieldDotLayer, glyphFieldDurationS } = await import('./glyph-scene.mjs');
    const pane = { width: 1056, height: 852 };
    const geometry = horizonPlanetGeometry(pane, { composerTop: 386 });
    const planet = { cx: geometry.cx, cy: geometry.cy, R: geometry.R };
    const maskAt = (strength) => glyphFrame({ view: { w: pane.width, h: pane.height }, dpr: 1, theme: 'dark',
        layers: [fieldDotLayer({ mode: 'still', seed: 7, strength, planet })] }, { time: glyphFieldDurationS }).field.mask;
    const mask = maskAt(1);
    const cell = 12;
    let empty = 0, near = 0, lit = 0;
    for (let j = 0; j < mask.height; j++) for (let i = 0; i < mask.width; i++) {
        const a = mask.rgba[(j * mask.width + i) * 4 + 3];
        const r = Math.hypot((i + 0.5) * cell - planet.cx, (j + 0.5) * cell - planet.cy) / planet.R;
        if (a < 0.05 * 255) empty++;
        if (a > 0) lit++;
        if (r < 1.02) near = Math.max(near, a);
    }
    assert.ok(empty > 0.3 * mask.width * mask.height, `patchy: ${empty} near-empty samples`);
    assert.ok(lit > 0, 'the field still shows away from the planet');
    assert.equal(near, 0, 'the field gives way to the planet');
    const weak = maskAt(0.3);
    let strong = 0, faint = 0;
    for (let k = 3; k < mask.rgba.length; k += 4) { strong += mask.rgba[k]; faint += weak.rgba[k]; }
    assert.ok(Math.abs(faint / strong - 0.3) < 0.03, `strength ratio ${faint / strong}`);
});
