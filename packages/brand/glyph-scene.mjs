import { PLANET_PALETTES, PLANET_SAMPLER, shadePlanetDot } from './planet.mjs';
import { orderedFade, rippleRingGeometry } from './atmosphere.mjs';
import { createGlyphFieldSampler } from './glyph-field.mjs';
export { fieldDotLayer, glyphFieldDurationS, glyphDotRadii, glyphFieldPhase, glyphFieldTrailCell, glyphFieldTrailLifeS, glyphFieldRippleLifeS } from './glyph-field.mjs';
import { markSdfAt } from './glyph-mark.mjs';

const { gradient, lightForReveal, REST_SPIN } = PLANET_SAMPLER;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, progress) => a + (b - a) * progress;
const smooth = (value) => { const k = clamp(value); return k * k * (3 - 2 * k); };
const fadeBetween = (value, from, to) => smooth((value - from) / (to - from));
const intensityLook = { quiet: [0.42, 0.7], calm: [0.66, 0.8], full: [1, 0.95] };
const restLight = lightForReveal(1);
const glyphPitch = [8, 16];
const retypeSeconds = 2;

export const planetGlyphLayer = (options) => ({ kind: 'planet', ...options });
export const markGlyphLayer = (options) => ({ kind: 'mark', ...options });
export const travellerGlyphLayer = (options) => ({ kind: 'traveller', ...options });
export const frontGlyphLayer = (options) => ({ kind: 'front', ...options });

function cellHash(x, y) {
    let bits = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
    bits = Math.imul(bits ^ (bits >>> 13), 1274126177);
    return ((bits ^ (bits >>> 16)) >>> 0) / 4294967296;
}

function digitOf(x, y, step = 0) {
    const chance = cellHash(x + step * 7, y - step * 13);
    return chance < 0.62 ? 1 + Math.floor(chance / 0.62 * 3) : Math.floor(cellHash(x * 3 + step, y + 11) * 10);
}

function frontEdge(shape, dx, dy, front, ragged, i, j) {
    const distance = shape === 'superellipse' ? Math.sqrt(Math.hypot(dx * dx, dy * dy)) : Math.max(dx, dy);
    return distance - front + (cellHash(i, j) - 0.5) * ragged;
}

function planetDecode(planet, fx, fy, i, j) {
    if (planet.decode >= 1) return 1;
    const edge = frontEdge('superellipse', fx, fy + 0.8, 2.8 * planet.decode, 0.18, i, j);
    return 1 - fadeBetween(edge, -0.07, 0.05);
}

function writeSprite(out, x, y, glyph, color, alpha) {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height || alpha <= 0) return;
    const at = out.count++;
    out.at[at * 2] = Math.round(x);
    out.at[at * 2 + 1] = Math.round(y);
    out.glyph[at] = glyph;
    out.rgba[at * 4] = color[0];
    out.rgba[at * 4 + 1] = color[1];
    out.rgba[at * 4 + 2] = color[2];
    out.rgba[at * 4 + 3] = Math.round(clamp(alpha) * 255);
}

function planetPresentation(layer, time) {
    const { geometry, settle, fall, intensity } = layer;
    const progress = settle ? smooth((time - (settle.startS ?? 0)) / settle.durationS) : 1;
    const [dim, glow] = intensityLook[intensity];
    const from = fall?.from;
    const k = from ? smooth((time - (fall.startS ?? 0)) / fall.durationS) : 1;
    return {
        cx: from ? mix(from.cx, geometry.cx, k) : geometry.cx,
        cy: from ? mix(from.cy, geometry.cy, k) : geometry.cy,
        R: from ? mix(from.R, geometry.R, k) : geometry.R,
        spin: geometry.spin ?? REST_SPIN,
        rotate: geometry.rotate,
        light: geometry.light ?? (geometry.reveal === undefined ? restLight : lightForReveal(geometry.reveal)),
        reveal: geometry.reveal ?? 1,
        dim: mix(1, dim, progress) * (geometry.dim ?? 1),
        glow: mix(0.95, glow, progress) * (geometry.glow ?? 1),
        halo: geometry.halo,
        gain: layer.gain ?? 1,
        ring: layer.ring,
        decode: layer.decode ?? 1,
        assembly: layer.assemble ? clamp((time - (layer.assemble.startS ?? 0)) / layer.assemble.durationS) : 1,
    };
}

function planetBody(out, grid, planet, fade, palette, previous) {
    const { cx, cy, R, spin, rotate, light, reveal, dim, glow, gain, assembly } = planet;
    const { dpr } = out;
    const { cols, rows, cell } = grid;
    const key = [cols, rows, ...cell, cx, cy, R, spin, rotate, ...light, reveal, dim, glow, gain, assembly, planet.decode, palette, fade?.from, fade?.to, dpr, out.height];
    if (previous && key.every((value, index) => previous.key[index] === value)) return previous;
    const rgba = previous?.body.rgba.length === cols * rows * 4 ? previous.body.rgba : new Uint8Array(cols * rows * 4);
    rgba.fill(0);
    const sine = Math.sin(-rotate), cosine = Math.cos(-rotate);
    const sample = { palette, light, reveal, spin, glow, breath: 0, reach: 7, bandStrength: 0.35, detail: 1.4 };
    const edge = Math.hypot(...cell) / (R * dpr);
    const lower = Math.min(rows, Math.ceil((fade?.to ?? out.height / dpr) * dpr / cell[1]));
    for (let j = 0; j < lower; j++) {
        const y = (j + 0.5) * cell[1] / dpr;
        const fy = (y - cy) / R;
        for (let i = 0; i < cols; i++) {
            const x = (i + 0.5) * cell[0] / dpr;
            const fx = (x - cx) / R;
            const distance = Math.hypot(fx, fy);
            if (distance > 1 + edge) continue;
            const decoded = planetDecode(planet, fx, fy, i, j);
            if (decoded === 0) continue;
            const shade = shadePlanetDot(fx * cosine - fy * sine, fx * sine + fy * cosine, i, j, sample);
            const strength = dim * gain;
            const appearance = assembly === 1 ? 1 : fadeBetween(assembly, cellHash(i, j) * 0.8, cellHash(i, j) * 0.8 + 0.2);
            const n = (j * cols + i) * 4;
            rgba[n] = Math.round(clamp(mix(palette.background[0], shade.rgb[0], strength), 0, 255));
            rgba[n + 1] = Math.round(clamp(mix(palette.background[1], shade.rgb[1], strength), 0, 255));
            rgba[n + 2] = Math.round(clamp(mix(palette.background[2], shade.rgb[2], strength), 0, 255));
            rgba[n + 3] = Math.round(255 * decoded * appearance * fadeBetween(assembly, 0, 0.12));
        }
    }
    const former = previous?.body;
    const fadeMask = fade ? former?.fadeMask?.height === out.height && former.fade?.from === fade.from * dpr && former.fade.to === fade.to * dpr
        ? former.fadeMask : makeFadeMask(out, fade) : null;
    return {
        key,
        body: { rgba, cols, rows, disc: { cx: cx * dpr, cy: cy * dpr, R: R * dpr }, fade: fade && { from: fade.from * dpr, to: fade.to * dpr }, fadeMask },
    };
}

function makeFadeMask(out, fade) {
    const width = 8 * Math.max(1, Math.round(2 * out.dpr));
    const height = out.height;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    orderedFade(rgba, width, height, fade.from, fade.to, out.dpr);
    return { rgba, width, height };
}

function samplePlanet(out, grid, layer, time, theme, palette, previous) {
    const planet = planetPresentation(layer, time);
    const body = planetBody(out, grid, planet, layer.fade, palette, previous);
    if (planet.ring) samplePlanetRing(out, grid, planet, palette, layer.fade);
    if (!layer.digits) return body;
    const { cx, cy, R, glow, dim, halo, assembly } = planet;
    const { cell, cols, rows } = grid;
    const step = Math.floor(time / retypeSeconds);
    const outsideInk = theme === 'dark' ? palette.body[6][1] : palette.body[5][1];
    const overInk = palette.background;
    for (let j = 0; j < rows; j++) {
        const y = (j + 0.5) * cell[1];
        const cssY = y / out.dpr;
        if (layer.fade && cssY >= layer.fade.to) break;
        const fy = (cssY - cy) / R;
        for (let i = 0; i < cols; i++) {
            const x = (i + 0.5) * cell[0];
            const fx = (x / out.dpr - cx) / R;
            const r = Math.hypot(fx, fy);
            const inside = r < 1;
            if ((!inside && r > 2.1) || cellHash(i + 911, j + 77) < 0.07) continue;
            const reach = ((fx < 0 ? halo.left : halo.right) * fx * fx + (fy < 0 ? halo.top : halo.bottom) * fy * fy) / (r * r || 1);
            const opacity = inside
                ? 0.62 * dim * (1 - fadeBetween(r, 0.9, 1))
                : (0.13 + 0.2 * Math.exp(-(r - 1) * 3)) * glow * reach * fadeBetween(r, 1, 1.05) * (1 - fadeBetween(r, 1, 2.1));
            const strike = cellHash(i + 401, j + 7) > 0.8 ? 0.45 : 1;
            const localStep = !inside && cellHash(i + 5, j + 9) < 0.15 ? step : 0;
            const foot = layer.fade ? 1 - fadeBetween(cssY, layer.fade.from, layer.fade.to) : 1;
            const alpha = opacity * strike * foot * fadeBetween(assembly, 0, 0.12) * planetDecode(planet, fx, fy, i, j);
            if (alpha >= 0.012) writeSprite(out, x, y, digitOf(i, j, localStep), inside ? overInk : outsideInk, alpha);
        }
    }
    return body;
}

function samplePlanetRing(out, grid, planet, palette, foot) {
    const x0 = planet.cx * out.dpr, y0 = planet.cy * out.dpr;
    const reach = Math.hypot(Math.max(Math.abs(x0), Math.abs(out.width - x0)), Math.max(Math.abs(y0), Math.abs(out.height - y0))) * 0.9;
    const [cellW, cellH] = grid.cell;
    const progress = planet.ring.progress;
    const { radius, band, fade } = rippleRingGeometry(progress, reach, cellH, out.dpr);
    const rowEnd = Math.min(grid.rows, Math.ceil((foot?.to ?? out.height / out.dpr) * out.dpr / cellH));
    const step = Math.floor(progress * 4);
    for (let j = 0; j < rowEnd; j++) {
        const y = (j + 0.5) * cellH;
        const footFade = foot ? 1 - fadeBetween(y / out.dpr, foot.from, foot.to) : 1;
        for (let i = 0; i < grid.cols; i += 2) {
            const x = (i + 0.5) * cellW;
            const depth = radius - Math.hypot(x - x0, y - y0);
            if (depth <= 0 || depth >= band || cellHash(i + 93, j) > 0.78) continue;
            const profile = Math.sin(Math.PI * Math.pow(1 - depth / band, 0.7));
            const ink = gradient(palette.body, 0.55 + 0.3 * cellHash(i + 95, j));
            writeSprite(out, x, y, digitOf(i, j, step), ink, profile * fade * 0.95 * footFade);
        }
    }
}

function sampleMark(out, grid, layer, time, palette) {
    const { centre, size, retypeS = 1.2, dissolve = 0, turn = 0, fill = 1 } = layer;
    const [cellW, cellH] = grid.cell;
    const radius = size / 2;
    const step = Math.floor(time / retypeS);
    const flip = Math.cos(clamp(turn) * 0.9);
    for (let j = 0; j < grid.rows; j++) {
        const y = (j + 0.5) * cellH;
        const fy = (y / out.dpr - centre.y) / radius;
        if (Math.abs(fy) > 1.08) continue;
        for (let i = 0; i < grid.cols; i++) {
            const x = (i + 0.5) * cellW;
            const fx = (x / out.dpr - centre.x) / (radius * flip);
            const distance = markSdfAt(fx, fy);
            if (distance <= 0 || cellHash(i + 33, j) < dissolve) continue;
            const arrival = distance < 0.05 ? 0.5 * cellHash(i, j + 11) : 0.3 + 0.7 * cellHash(i, j + 11);
            if (fill < arrival) continue;
            const color = gradient(palette.body, clamp(0.08 + (fy + 1) * 0.42 - fx * 0.1));
            writeSprite(out, x, y, digitOf(i, j, step), color, 1);
        }
    }
}

function sampleTravellers(out, layer, time, palette) {
    const { particles, ink, small } = layer;
    for (let i = 0; i < particles.length; i += 8) {
        const emit = particles[i + 4], duration = particles[i + 5];
        if (time < emit || time > emit + duration) continue;
        const p = duration === 0 ? 1 : clamp((time - emit) / duration);
        const travel = smooth(p);
        const x = mix(particles[i], particles[i + 2], travel);
        const y = mix(particles[i + 1], particles[i + 3], travel) - Math.sin(Math.PI * p) * particles[i + 6];
        const tone = particles[i + 7];
        const color = ink === 'sunrise' ? gradient(palette.body, clamp(tone)) : ink;
        writeSprite(out, x * out.dpr, y * out.dpr, digitOf(i, 0, Math.floor(time * 6)) + (small ? 10 : 0), color, (color[3] ?? 255) / 255);
    }
}

function sampleFront(out, grid, layer, time, palette) {
    const { rect, origin, shape, front, band, ragged, alpha, ink, mode, inkMap, cover } = layer;
    const area = rect ?? { x: 0, y: 0, width: out.width / out.dpr, height: out.height / out.dpr };
    const ox = origin?.x ?? area.x + area.width / 2, oy = origin?.y ?? area.y + area.height / 2;
    const [dw, dh] = grid.cell;
    const step = Math.floor(time * 6);
    for (let j = 0; j < grid.rows; j++) {
        const y = (j + 0.5) * dh / out.dpr;
        if (y < area.y || y >= area.y + area.height) continue;
        for (let i = 0; i < grid.cols; i++) {
            const x = (i + 0.5) * dw / out.dpr;
            if (x < area.x || x >= area.x + area.width) continue;
            const edge = frontEdge(shape, Math.abs(x - ox), Math.abs(y - oy), front, ragged, i, j);
            if (mode === 'decode' && cover && edge >= 0) writeSprite(out, x * out.dpr, y * out.dpr, 20, cover, (cover[3] ?? 255) / 255);
            if (Math.abs(edge) >= band) continue;
            const color = ink === 'sunrise' ? gradient(palette.body, clamp(y / (out.height / out.dpr))) : ink;
            const mapped = inkMap?.rgba;
            const index = (j * grid.cols + i) * 4;
            const amount = alpha * (1 - Math.abs(edge) / band) * (mapped && mode === 'eat' ? (mapped[index + 3] ?? 0) / 255 : 1);
            writeSprite(out, x * out.dpr, y * out.dpr, digitOf(i, j, step), color, amount);
        }
    }
}

export function inkMapFromBoxes(boxes, grid) {
    const rgba = new Uint8Array(grid.cols * grid.rows * 4);
    const [w, h] = grid.cell;
    for (const box of boxes) {
        const left = Math.max(0, Math.floor(box.x / w));
        const top = Math.max(0, Math.floor(box.y / h));
        const right = Math.min(grid.cols, Math.ceil((box.x + box.width) / w));
        const bottom = Math.min(grid.rows, Math.ceil((box.y + box.height) / h));
        for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
                const at = (y * grid.cols + x) * 4;
                rgba[at] = box.ink[0];
                rgba[at + 1] = box.ink[1];
                rgba[at + 2] = box.ink[2];
                rgba[at + 3] = box.ink[3] ?? 255;
            }
        }
    }
    return { rgba, cols: grid.cols, rows: grid.rows };
}

export function inkMapFromImage(pixels, grid) {
    const rgba = new Uint8Array(grid.cols * grid.rows * 4);
    for (let j = 0; j < grid.rows; j++) {
        const y = Math.min(pixels.height - 1, Math.floor((j + 0.5) * pixels.height / grid.rows));
        for (let i = 0; i < grid.cols; i++) {
            const x = Math.min(pixels.width - 1, Math.floor((i + 0.5) * pixels.width / grid.cols));
            const at = (j * grid.cols + i) * 4;
            const source = (y * pixels.width + x) * 4;
            rgba.set(pixels.data.subarray(source, source + 4), at);
        }
    }
    return { rgba, cols: grid.cols, rows: grid.rows };
}

/** One sampler per surface owns reusable sprite storage. Its frames live until the next sample. */
export function createGlyphFrameSampler() {
    let storage = { at: new Uint16Array(0), glyph: new Uint8Array(0), rgba: new Uint8Array(0) };
    let previousBody;
    const sampleField = createGlyphFieldSampler();
    return function sample(scene, { time = 0 } = {}) {
        const { dpr, theme, view, layers } = scene;
        const width = Math.round(view.w * dpr), height = Math.round(view.h * dpr);
        const cell = (scene.cell ?? glyphPitch).map((pitch) => Math.max(1, Math.round(pitch * dpr)));
        const cols = Math.ceil(width / cell[0]), rows = Math.ceil(height / cell[1]);
        const grid = { cell, cols, rows, origin: [0, 0] };
        const capacity = layers.reduce((sum, layer) => sum + (layer.kind === 'field' ? 0 : layer.kind === 'traveller' ? layer.particles.length / 8 : cols * rows * ((layer.kind === 'front' && layer.cover) || (layer.kind === 'planet' && layer.ring) ? 2 : 1)), 0);
        if (capacity > storage.glyph.length) storage = { at: new Uint16Array(capacity * 2), glyph: new Uint8Array(capacity), rgba: new Uint8Array(capacity * 4) };
        const out = { ...storage, dpr, width, height, count: 0 };
        const palette = PLANET_PALETTES[theme];
        let body;
        let field;
        for (const layer of layers) {
            if (layer.kind === 'field') field = layer;
            if (layer.kind === 'planet') body = samplePlanet(out, grid, layer, time, theme, palette, previousBody);
            if (layer.kind === 'mark') sampleMark(out, grid, layer, time, palette);
            if (layer.kind === 'traveller') sampleTravellers(out, layer, layer.presentationTimeS ?? time, palette);
            if (layer.kind === 'front') sampleFront(out, grid, layer, time, palette);
        }
        previousBody = body;
        const { count, at, rgba, glyph } = out;
        return { width, height, grid, sprites: { at: at.subarray(0, count * 2), rgba: rgba.subarray(0, count * 4), glyph: glyph.subarray(0, count) }, body: body?.body ?? null, field: sampleField(field, time, width, height, dpr, theme, palette) };
    };
}

/** Static consumers own their single frame. */
export function glyphFrame(scene, motion) {
    return createGlyphFrameSampler()(scene, motion);
}
