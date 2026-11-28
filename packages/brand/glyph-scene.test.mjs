import assert from 'node:assert/strict';
import test from 'node:test';

import { glyphFrame, glyphLatticeTile, glyphPlanetDigitFirstTile, glyphRampFirstTile, planetGlyphLayer, travellerGlyphLayer, frontGlyphLayer, markGlyphLayer } from './glyph-scene.mjs';
import { horizonPlanetGeometry, welcomePlanetPose } from './planet-placement.mjs';

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

test('the default planet ink is full-colour across signed-out poses', () => {
    const pane = { width: view.w, height: view.h };
    for (const pose of ['welcome', 'deep', 'night', 'sheet', 'welcomeDim']) {
        const geometry = welcomePlanetPose(pose, pane, { phone: true });
        const options = { geometry, digits: true, soft: true };
        const full = render([planetGlyphLayer({ ...options, intensity: 'full' })]);
        const quiet = render([planetGlyphLayer({ ...options, intensity: 'quiet' })]);
        assert.notDeepEqual(full, quiet, `${pose} distinguishes Full from Quiet`);
        const firstOpen = render([planetGlyphLayer(options)]);
        assert.deepEqual(firstOpen, full, `${pose} keeps the lab pose in full-colour ink`);
    }
});

test('the phone body texture carries surface ink through the circle clip', () => {
    const geometry = welcomePlanetPose('welcome', { width: view.w, height: view.h }, { phone: true });
    const layers = [planetGlyphLayer({ geometry, soft: true })];
    for (const dpr of [2, 3]) {
        for (const theme of ['light', 'dark']) {
            const { body, grid } = glyphFrame({ view, dpr, theme, layers });
            const column = Math.floor(body.disc.cx / grid.cell[0]);
            const outerRow = Math.floor((body.disc.cy - body.disc.R) / grid.cell[1] - 0.5);
            const inner = ((outerRow + 1) * grid.cols + column) * 4;
            const outer = inner - grid.cols * 4;
            assert.equal(body.rgba[outer + 3], body.rgba[inner + 3], 'only the circle clips the wash');
            const channelJump = Math.max(...[0, 1, 2].map(channel => Math.abs(body.rgba[outer + channel] - body.rgba[inner + channel])));
            assert.ok(channelJump < 45, `${theme} at ${dpr}×: the body must not interpolate into halo ink (${channelJump})`);
        }
    }
});

test('phone lattice dots just outside the limb retain the sparse halo density', () => {
    const geometry = welcomePlanetPose('welcome', { width: view.w, height: view.h }, { phone: true });
    const { sprites } = glyphFrame({
        view, dpr: 2, theme: 'dark', layers: [planetGlyphLayer({ geometry, soft: true })],
    });
    let haloDots = 0;
    let surfaceDots = 0;
    for (let i = 0; i < sprites.glyph.length; i++) {
        if (sprites.glyph[i] !== glyphLatticeTile) continue;
        const radius = Math.hypot(sprites.at[i * 2] / 2 - geometry.cx, sprites.at[i * 2 + 1] / 2 - geometry.cy);
        const depth = geometry.R - radius;
        if (depth >= -4 && depth < 0) haloDots++;
        if (depth >= 0 && depth < 4) surfaceDots++;
    }
    assert.ok(haloDots < surfaceDots / 2, `dense surface dots leaked outside the limb: ${haloDots} vs ${surfaceDots}`);
});

// The Loading planet's own grid, as the launch surface and the poster draw it.
const loadingView = (size) => ({ w: size, h: size });
const loadingDraw = (layers, size, time) => glyphFrame({ view: loadingView(size), dpr: 1, theme: 'light', layers }, { time });
const isPlanetInk = (tile) => tile >= glyphRampFirstTile && tile < glyphPlanetDigitFirstTile;
const isGatheringDigit = (tile) => tile >= 10 && tile < 20;
const spritesOf = (frame, keep) => [...frame.sprites.glyph].flatMap((tile, index) => keep(tile)
    ? [{ x: frame.sprites.at[index * 2], y: frame.sprites.at[index * 2 + 1], alpha: frame.sprites.rgba[index * 4 + 3] }] : []);
/** Share of the disc's grid cells (inside 0.9 R) that carry visible planet ink. */
function discCoverage(frame, disc) {
    const [cw, ch] = frame.grid.cell;
    const inked = new Set(spritesOf(frame, isPlanetInk).filter(({ alpha }) => alpha > 24)
        .map(({ x, y }) => `${Math.floor(x / cw)}:${Math.floor(y / ch)}`));
    let cells = 0, covered = 0;
    for (let j = 0; j < frame.grid.rows; j++) for (let i = 0; i < frame.grid.cols; i++) {
        const x = (i + 0.5) * cw, y = (j + 0.5) * ch;
        if (Math.hypot(x - disc.cx, y - disc.cy) > disc.R * 0.9) continue;
        cells++;
        if (inked.has(`${i}:${j}`)) covered++;
    }
    return covered / cells;
}

test('the Loading planet rests whole: its Still frame fills the disc and holds no loose digits', async () => {
    const { createLoadingPlanetScene, loadingPlanetSize } = await import('./glyph-scene.mjs');
    const still = loadingDraw(createLoadingPlanetScene()(0), loadingPlanetSize, 0);
    assert.ok(discCoverage(still, still.body.disc) > 0.9, `coverage ${discCoverage(still, still.body.disc)}`);
    assert.equal(spritesOf(still, isGatheringDigit).length, 0);
    assert.deepEqual(loadingDraw(createLoadingPlanetScene()(0), loadingPlanetSize, 0), still, 'the Still frame has no history');
});

test('the Loading planet decodes in once, then stays whole while digits keep gathering into it', async () => {
    const { createLoadingPlanetScene, loadingPlanetDecodeS } = await import('./glyph-scene.mjs');
    const size = 900, origin = { cx: 450, cy: 405, R: 150 };
    const scene = createLoadingPlanetScene();
    const at = (t) => loadingDraw(scene(t, origin, 1, 0), size, t);
    const whole = discCoverage(loadingDraw(createLoadingPlanetScene()(0, origin), size, 0), origin);
    const early = at(loadingPlanetDecodeS * 0.3);
    assert.ok(discCoverage(early, origin) < whole * 0.5, 'the planet is still decoding behind its front');
    assert.ok(spritesOf(early, (tile) => tile < 10).length > 0, 'the front scrambles digits');
    let near = 0, far = 0;
    for (let t = loadingPlanetDecodeS; t < 60; t += 0.37) {
        const frame = at(t);
        assert.ok(discCoverage(frame, origin) >= whole * 0.98, `whole at ${t.toFixed(2)} s`);
        const digits = spritesOf(frame, isGatheringDigit);
        if (t > 1.5) assert.ok(digits.length > 0, `digits gathering at ${t.toFixed(2)} s`);
        for (const { x, y } of digits) {
            const distance = Math.hypot(x - origin.cx, y - origin.cy) / origin.R;
            if (distance < 1.05) near++;
            if (distance > 1.3) far++;
        }
    }
    assert.ok(near > 20 && far > 20, `digits travel from outside into the limb (${far} far, ${near} near)`);
});

test('the Loading planet breathes visibly within a short load, in step with the brand cycle', async () => {
    const { createLoadingPlanetScene, loadingPlanetBreathS } = await import('./glyph-scene.mjs');
    const { PLANET_BREATH_SECONDS } = await import('./planet.mjs');
    const scene = createLoadingPlanetScene();
    const radius = (t) => scene(t)[0].geometry.R;
    // Most loads last two or three seconds: the planet must already have grown noticeably by then.
    assert.ok(radius(1.2) > radius(0) * 1.025, `grown ${(radius(1.2) / radius(0) - 1) * 100}% at 1.2 s`);
    assert.ok(radius(loadingPlanetBreathS / 2) > radius(0) * 1.05);
    assert.ok(Math.abs(radius(loadingPlanetBreathS) - radius(0)) < 1e-9);
    assert.equal(PLANET_BREATH_SECONDS % loadingPlanetBreathS, 0);
});

test('travellers land at the specified endpoint and fronts sample deterministically', () => {
    const particle = travellerGlyphLayer({ particles: new Float32Array([4, 8, 84, 120, 0.5, 1, 16, 0]), ink: [200, 100, 50, 255] });
    const front = frontGlyphLayer({ shape: 'roundRect', rect: { x: 0, y: 0, width: 80, height: 90 }, front: 48, band: 16, ragged: 8, alpha: 1, ink: [200, 100, 50, 255], mode: 'eat' });
    assert.deepEqual(Array.from(render([particle], 1.5).sprites.at), [126, 180]);
    assert.deepEqual(render([front], 0.12), render([front], 0.12));
});

test('the two step fronts draw digits only in sampled ink cells', () => {
    const rgba = new Uint8Array(5 * 5 * 4);
    rgba[(1 * 5 + 2) * 4 + 3] = 255;
    const inkMap = { cols: 5, rows: 5, rgba };
    for (const mode of ['eat', 'decode']) {
        const front = frontGlyphLayer({ mode, shape: 'horizontal', rect: { x: 0, y: 0, width: 40, height: 80 },
            front: 28, band: 32, ragged: 0, alpha: 1, ink: [200, 100, 50, 255], inkMap });
        const frame = glyphFrame({ view, dpr: 1, theme: 'dark', layers: [front] });
        assert.deepEqual(Array.from(frame.sprites.at), [20, 24], mode);
    }
    rgba[(4 * 5 + 2) * 4 + 3] = 255;
    const climb = frontGlyphLayer({ mode: 'eat', shape: 'horizontal', rect: { x: 0, y: 0, width: 40, height: 80 },
        front: 70, band: 16, ragged: 0, alpha: 1, ink: [200, 100, 50, 255], inkMap, climbProgress: 0 });
    const frame = glyphFrame({ view, dpr: 1, theme: 'dark', layers: [climb] });
    assert.deepEqual(Array.from(frame.sprites.at), [20, 72]);
});

test('the opening band is a sparse row behind its front that thins away, across the same height', () => {
    const rect = { x: 0, y: 0, width: 240, height: 480 };
    const options = { mode: 'decode', shape: 'horizontal', rect, front: 240, band: 150, ragged: 0, alpha: 0.4, ink: [200, 100, 50, 255] };
    const draw = (layer) => glyphFrame({ view: { w: 240, h: 480 }, dpr: 1, theme: 'dark', layers: [layer] }).sprites;
    const solid = draw(frontGlyphLayer(options));
    const sparse = draw(frontGlyphLayer({ ...options, sparse: true }));
    const cells = Array.from(sparse.glyph, (_, n) => ({ y: sparse.at[2 * n + 1], alpha: sparse.rgba[4 * n + 3] }));
    assert.ok(cells.length > 0);
    assert.ok(cells.length < solid.glyph.length * 0.5, `${cells.length} of ${solid.glyph.length}`);
    // The band keeps its height (front ± band); the leading rows sit above the front as it climbs.
    assert.ok(cells.every(({ y }) => y > 240 - 150 && y < 240 + 150));
    const meanAlpha = (from, to) => {
        const share = cells.filter(({ y }) => y >= from && y < to);
        return share.reduce((sum, { alpha }) => sum + alpha, 0) / share.length;
    };
    assert.ok(meanAlpha(290, 390) < meanAlpha(190, 290), 'it thins away behind the front');
});

test('opening mark cells lock and depart on the same times their travellers are authored against', () => {
    const layer = markGlyphLayer({ centre: { x: 120, y: 120 }, size: 108, ink: 'sunrise',
        cellTimeline: new Float32Array([120, 126, 0.5, 1.25, 144, 148, 0.75, 1.5]) });
    const isDigit = (glyph) => glyph >= glyphPlanetDigitFirstTile && glyph < glyphPlanetDigitFirstTile + 10;
    const digits = (frame) => Array.from(frame.sprites.glyph).flatMap((glyph, n) => isDigit(glyph) ? [frame.sprites.at[2 * n], frame.sprites.at[2 * n + 1]] : []);
    assert.deepEqual(digits(render([layer], 0.49)), []);
    assert.deepEqual(digits(render([layer], 0.5)), [180, 189]);
    assert.deepEqual(digits(render([layer], 0.75)), [180, 189, 216, 222]);
    assert.deepEqual(digits(render([layer], 1.25)), [216, 222]);
    assert.deepEqual(digits(render([layer], 1.5)), []);
    const turned = digits(render([{ ...layer, turn: 1 }], 1.25));
    assert.ok(turned[0] < 216 && turned[0] > 180);
    assert.equal(turned[1], 222);
    // Each locked cell reads as a filled cell: a wash and lattice dots surround its digit (the lab's silhouette).
    const held = render([layer], 0.5);
    const dots = Array.from(held.sprites.glyph).filter((glyph) => glyph === glyphLatticeTile).length;
    assert.ok(dots >= 4, `lattice dots under the mark cell: ${dots}`);
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

test('a travelling field or ripple uses its own elapsed time while the planet digits hold their step', async () => {
    const { glyphPlanetDigitFirstTile, fieldDotLayer } = await import('./glyph-scene.mjs');
    const pane = { width: 880, height: 690 };
    const geometry = horizonPlanetGeometry(pane, { composerTop: 350 });
    const sample = (time, digitTimeS) => glyphFrame({ view: { w: pane.width, h: pane.height }, dpr: 1, theme: 'dark', layers: [
        fieldDotLayer({ mode: 'animated' }),
        planetGlyphLayer({ geometry, intensity: 'quiet', digits: true, ring: { progress: 0.2 }, digitTimeS }),
    ] }, { time });
    const digits = ({ sprites }) => Array.from(sprites.glyph, (glyph, i) => [sprites.at[i * 2], sprites.at[i * 2 + 1], glyph])
        .filter(([, , glyph]) => glyph >= glyphPlanetDigitFirstTile && glyph < glyphPlanetDigitFirstTile + 10);
    const held = sample(0, 6);
    const moved = sample(3, 6);
    assert.notDeepEqual(held.field.mask.rgba, moved.field.mask.rgba);
    assert.ok(digits(held).length > 0);
    assert.deepEqual(digits(held), digits(moved));
    assert.notDeepEqual(digits(moved), digits(sample(3, 8)));
});

test('Welcome and Approve keep body digits inside the limb and draw the halo only with dots', () => {
    const pane = { width: 1224, height: 765 };
    for (const state of ['welcome', 'deep']) {
        const geometry = welcomePlanetPose(state, pane);
        for (const time of [0, 2]) {
            const { sprites } = glyphFrame({ view: { w: pane.width, h: pane.height }, dpr: 2, theme: 'dark',
                layers: [planetGlyphLayer({ geometry, intensity: 'quiet', digits: true })] }, { time });
            const haloTiles = new Set();
            let digits = 0;
            for (const [index, glyph] of sprites.glyph.entries()) {
                const x = sprites.at[index * 2] / 2;
                const y = sprites.at[index * 2 + 1] / 2;
                if (Math.hypot(x - geometry.cx, y - geometry.cy) >= geometry.R) haloTiles.add(glyph);
                else if (glyph >= glyphPlanetDigitFirstTile && glyph < glyphPlanetDigitFirstTile + 10) digits++;
            }
            assert.ok(digits > 0, `${state} keeps digits in the planet body`);
            assert.deepEqual([...haloTiles].sort((a, b) => a - b), [glyphLatticeTile], `${state} halo tiles at ${time}s`);
        }
    }
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
