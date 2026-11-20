import { PLANET_PALETTES, PLANET_SAMPLER, PLANET_SCENE_RENDERER, shadePlanetDot } from './planet.mjs';
import { orderedFade, rippleRingGeometry } from './atmosphere.mjs';
import { createGlyphFieldSampler, glyphDotRadii } from './glyph-field.mjs';
export { fieldDotLayer, glyphFieldDurationS, glyphDotRadii, glyphFieldPhase, glyphFieldTrailCell, glyphFieldTrailLifeS, glyphFieldRippleLifeS } from './glyph-field.mjs';
import { markSdfAt } from './glyph-mark.mjs';

const { gradient, lightForReveal, REST_SPIN, BAYER } = PLANET_SAMPLER;
const { sceneHash: cellHash, digitAtStep: digitOf } = PLANET_SCENE_RENDERER;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, progress) => a + (b - a) * progress;
const smooth = (value) => { const k = clamp(value); return k * k * (3 - 2 * k); };
const fadeBetween = (value, from, to) => smooth((value - from) / (to - from));
const intensityLook = { quiet: [0.42, 0.7], calm: [0.66, 0.8], full: [1, 0.95] };
const homeFieldLook = { quiet: 0.5, calm: 0.7, full: 1 };

/** Home's dot field strength: quieter with the planet's intensity, and quieter again on a phone. */
export function homeFieldStrength(intensity, { phone = false } = {}) {
    return homeFieldLook[intensity] * (phone ? 0.5 : 0.6);
}
const restLight = lightForReveal(1);
const glyphPitch = [8, 16];
export const glyphDigitStepS = 2;

export const planetGlyphLayer = (options) => ({ kind: 'planet', ...options, intensity: options.intensity ?? 'full' });
export const markGlyphLayer = (options) => ({ kind: 'mark', ...options });
export const travellerGlyphLayer = (options) => ({ kind: 'traveller', ...options });
export const frontGlyphLayer = (options) => ({ kind: 'front', ...options });
export const placedGlyphLayer = (cells) => ({ kind: 'placed', cells });

export const loadingPlanetSize = 256;
const loadingPlanetCentre = loadingPlanetSize / 2;
const loadingPlanetOrigin = { cx: loadingPlanetCentre, cy: loadingPlanetCentre, R: 57 };
const loadingPlanetHalo = { top: 1, right: 1, bottom: 1, left: 1 };

/** The launch poster is this scene at time zero. The same traveller tiles carry its floating digits. */
export function createLoadingPlanetScene() {
    const count = 14;
    const particles = new Float32Array(count * 8);
    const floatingDigits = travellerGlyphLayer({ particles, ink: 'sunrise', small: true, alpha: 0.62, presentationTimeS: 0 });
    for (let index = 0; index < count; index++) particles[index * 8 + 7] = cellHash(index, 32);
    return (seconds, origin = loadingPlanetOrigin, orbitOpacity = 1) => {
        const phase = seconds / 3.6 * Math.PI * 2;
        const radius = origin.R * (1 + 0.018 * (1 - Math.cos(phase)));
        for (let index = 0; index < count; index++) {
            const at = index * 8;
            const seed = particles[at + 7];
            const angle = Math.PI * 2 * (index + seed * 0.55) / count + seconds * (0.21 + seed * 0.12);
            const orbit = radius * (1.28 + seed * 0.43 + 0.035 * Math.sin(phase + index));
            particles[at] = particles[at + 2] = origin.cx + Math.cos(angle) * orbit;
            particles[at + 1] = particles[at + 3] = origin.cy + Math.sin(angle) * orbit * 0.89;
        }
        const planet = planetGlyphLayer({ geometry: { ...origin, R: radius, rotate: -1.5, halo: loadingPlanetHalo }, digits: true, digitTimeS: 0 });
        return [planet, orbitOpacity === 1 ? floatingDigits : { ...floatingDigits, alpha: floatingDigits.alpha * orbitOpacity }];
    };
}

function frontEdge(shape, dx, dy, front, ragged, i, j) {
    const distance = shape === 'superellipse' ? Math.sqrt(Math.hypot(dx * dx, dy * dy)) : Math.max(dx, dy);
    return distance - front + (cellHash(i, j) - 0.5) * ragged;
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
        assembly: layer.assemble ? clamp((time - (layer.assemble.startS ?? 0)) / layer.assemble.durationS) : 1,
    };
}

// The glyph planet (first-open lab, Home's Horizon): each cell takes a glyph from the light ramp by how much light
// it holds, in the planet's own ink, over a faint wash of its body colour. The halo uses the dot lattice alone.
// The intensity's `dim` is the whole planet's opacity. A phone keeps a sparse share of cells, each nudged and dimmed.
export const glyphRampChars = '.\u00b7:-=+*%#@';
export const glyphRampFirstTile = 21 + glyphDotRadii.length;
/** The planet's own digits, set at the ramp's size: tiles after the ramp. */
export const glyphPlanetDigitFirstTile = glyphRampFirstTile + glyphRampChars.length;
/** The planet's dot lattice under its glyphs: one dot tile after the planet digits, radius in css px. */
export const glyphLatticeTile = glyphPlanetDigitFirstTile + 10;
export const glyphLatticeRadius = 1.44;
const latticePitch = 4;
const glyphWash = 0.16;
const haloReach = 1.8;
const glyphFieldInk = { light: [140, 135, 143], dark: [107, 105, 120] };

/** A cell's glyph ink: dark lifts each colour to full value, light deepens it (the brand's light dot ink). */
function glyphInk(rgb, theme, background, into) {
    const peak = Math.max(rgb[0], rgb[1], rgb[2]);
    const base = glyphFieldInk[theme] ?? glyphFieldInk.dark;
    if (theme === 'light') {
        const k = fadeBetween(Math.hypot(rgb[0] - background[0], rgb[1] - background[1], rgb[2] - background[2]) / 255, 0.02, 0.25);
        for (let c = 0; c < 3; c++) into[c] = Math.round(mix(base[c], clamp(peak - (peak - rgb[c]) * 1.7, 0, 255) * 0.82, k));
    } else {
        const k = fadeBetween(peak / 255, 0.08, 0.4);
        for (let c = 0; c < 3; c++) into[c] = Math.round(mix(base[c], peak > 0 ? rgb[c] * 255 / peak : 0, k));
    }
    return into;
}

// The intensity's `dim` and a moment's `gain` are the planet's opacity: applied when cells are written, so a
// settle or a ripple never re-shades the planet.
function planetBody(out, grid, planet, fade, palette, previous, theme, soft) {
    const shaded = shadePlanetCells(out, grid, planet, fade, palette, previous, theme, soft);
    const opacity = clamp(planet.dim * planet.gain);
    if (shaded.opacity === opacity) return shaded;
    const { rgba } = shaded.body, { wash } = shaded.cells;
    for (let n = 0; n < wash.length; n++) rgba[n * 4 + 3] = Math.round(255 * wash[n] * opacity);
    return { ...shaded, opacity, body: { ...shaded.body } };
}

function shadePlanetCells(out, grid, planet, fade, palette, previous, theme, soft) {
    const { cx, cy, R, spin, rotate, light, reveal, glow, assembly, halo } = planet;
    const { dpr } = out;
    const { cols, rows, cell } = grid;
    const key = [cols, rows, ...cell, cx, cy, R, spin, rotate, ...light, reveal, glow, assembly, palette, fade?.from, fade?.to, dpr, out.height, theme, soft];
    if (previous && key.every((value, index) => previous.key[index] === value)) return previous;
    const size = cols * rows;
    const reuse = previous?.body.rgba.length === size * 4;
    const rgba = reuse ? previous.body.rgba : new Uint8Array(size * 4);
    const perCell = 1 + Math.ceil(cell[0] / dpr / latticePitch) * Math.ceil(cell[1] / dpr / latticePitch);
    const reuseCells = reuse && previous.cells.rampGlyph.length === size * perCell;
    const cells = reuseCells ? previous.cells : { light: new Float32Array(size), ink: new Uint8Array(size * 3), base: new Float32Array(size), wash: new Float32Array(size),
        rampAt: new Uint16Array(size * perCell * 2), rampGlyph: new Uint8Array(size * perCell), rampRgba: new Uint8Array(size * perCell * 4), ramp: 0 };
    rgba.fill(0);
    cells.light.fill(0);
    cells.wash.fill(0);
    cells.ramp = 0;
    const sine = Math.sin(-rotate), cosine = Math.cos(-rotate);
    const sample = { palette, light, reveal, spin, glow, breath: 0, reach: 7, bandStrength: 0.35, detail: 1.4 };
    const edge = Math.hypot(...cell) / (R * dpr);
    const ink = [0, 0, 0], dot = [0, 0, 0];
    const faint = soft ? 0.85 : 0.3;
    const add = (x, y, glyph, colour, alpha) => {
        const r = cells.ramp++;
        cells.rampAt[r * 2] = Math.round(x);
        cells.rampAt[r * 2 + 1] = Math.round(y);
        cells.rampGlyph[r] = glyph;
        cells.rampRgba.set(colour, r * 4);
        cells.rampRgba[r * 4 + 3] = alpha;
    };
    const lower = Math.min(rows, Math.ceil((fade?.to ?? out.height / dpr) * dpr / cell[1]));
    for (let j = 0; j < lower; j++) {
        const y = (j + 0.5) * cell[1] / dpr;
        const fy = (y - cy) / R;
        const foot = fade ? 1 - fadeBetween(y, fade.from, fade.to) : 1;
        for (let i = 0; i < cols; i++) {
            const x = (i + 0.5) * cell[0] / dpr;
            const fx = (x - cx) / R;
            const distance = Math.hypot(fx, fy);
            if (distance > haloReach) continue;
            const shade = shadePlanetDot(fx * cosine - fy * sine, fx * sine + fy * cosine, i, j, sample);
            const appearance = (assembly === 1 ? 1 : fadeBetween(assembly, cellHash(i, j) * 0.8, cellHash(i, j) * 0.8 + 0.2)) * fadeBetween(assembly, 0, 0.12);
            const n = j * cols + i;
            const inside = distance < 1;
            if (distance <= 1 + edge) {
                rgba[n * 4] = shade.rgb[0];
                rgba[n * 4 + 1] = shade.rgb[1];
                rgba[n * 4 + 2] = shade.rgb[2];
                cells.wash[n] = glyphWash * appearance;
            }
            const sides = inside ? 1 : ((fx < 0 ? halo.left : halo.right) * fx * fx + (fy < 0 ? halo.top : halo.bottom) * fy * fy) / (distance * distance || 1);
            const amount = shade.light * sides;
            if (amount < 0.04) continue;
            const base = appearance * foot;
            // The lattice: dots on a fixed 4 px pitch, each lit when the cell's light passes its ordered dither.
            const peak = Math.max(shade.rgb[0], shade.rgb[1], shade.rgb[2]);
            for (let c = 0; c < 3; c++) dot[c] = theme === 'light' ? Math.round(clamp(peak - (peak - shade.rgb[c]) * 1.4, 0, 255)) : shade.rgb[c];
            const left = i * cell[0] / dpr, top = j * cell[1] / dpr;
            const dotAlpha = Math.round(255 * clamp(base * faint));
            if (dotAlpha > 0) {
                for (let dy = Math.ceil(top / latticePitch - 0.5); (dy + 0.5) * latticePitch < top + cell[1] / dpr; dy++) {
                    for (let dx = Math.ceil(left / latticePitch - 0.5); (dx + 0.5) * latticePitch < left + cell[0] / dpr; dx++) {
                        if (BAYER[(dy & 3) * 4 + (dx & 3)] + 0.02 >= amount) continue;
                        add((dx + 0.5) * latticePitch * dpr, (dy + 0.5) * latticePitch * dpr, glyphLatticeTile, dot, dotAlpha);
                    }
                }
            }
            if (!inside) continue;
            glyphInk(shade.rgb, theme, palette.background, ink);
            cells.light[n] = amount;
            cells.base[n] = base;
            cells.ink.set(ink, n * 3);
            const level = Math.floor(amount ** 1.6 * 10.999);
            if (level < 1) continue;
            let px = (i + 0.5) * cell[0], py = (j + 0.5) * cell[1], keep = 1;
            if (soft) {
                if (cellHash(i + 13, j + 29) >= 0.3) continue;
                px += (cellHash(i + 3, j + 7) - 0.5) * 0.22 * cell[0];
                py += (cellHash(i + 11, j + 5) - 0.5) * 0.22 * cell[1];
                keep = 0.45 + 0.55 * cellHash(i + 19, j + 2);
            }
            const alpha = Math.round(255 * clamp(base * keep));
            if (alpha > 0) add(px, py, glyphRampFirstTile + level - 1, ink, alpha);
        }
    }
    const former = previous?.body;
    const fadeMask = fade ? former?.fadeMask?.height === out.height && former.fade?.from === fade.from * dpr && former.fade.to === fade.to * dpr
        ? former.fadeMask : makeFadeMask(out, fade) : null;
    return {
        key,
        cells,
        opacity: NaN,
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
    const body = planetBody(out, grid, planet, layer.fade, palette, previous, theme, layer.soft === true);
    const { cells, opacity } = body;
    for (let r = 0; r < cells.ramp; r++) {
        const alpha = Math.round(cells.rampRgba[r * 4 + 3] * opacity);
        if (alpha <= 0 || out.count >= out.glyph.length) continue;
        const at = out.count++;
        out.at[at * 2] = cells.rampAt[r * 2];
        out.at[at * 2 + 1] = cells.rampAt[r * 2 + 1];
        out.glyph[at] = cells.rampGlyph[r];
        out.rgba[at * 4] = cells.rampRgba[r * 4];
        out.rgba[at * 4 + 1] = cells.rampRgba[r * 4 + 1];
        out.rgba[at * 4 + 2] = cells.rampRgba[r * 4 + 2];
        out.rgba[at * 4 + 3] = alpha;
    }
    if (planet.ring) samplePlanetRing(out, grid, planet, palette, layer.fade);
    if (!layer.digits) return body;
    // Home's digits: a sparse share of the lit cells in the planet's ink, a share of them retyping each step.
    const { cell, cols } = grid;
    const step = Math.floor((layer.digitTimeS ?? time) / glyphDigitStepS);
    const ink = out.ink;
    for (let n = 0; n < cells.light.length; n++) {
        const amount = cells.light[n];
        if (amount === 0) continue;
        const i = n % cols, j = (n - i) / cols;
        if (cellHash(i + 31, j + 7) >= 0.42) continue;
        const local = cellHash(i + 9, j + 2) < 0.35 ? step : 0;
        const digit = Math.floor(cellHash(i + local * 7 + 3, j - local * 13) * 10);
        const alpha = fadeBetween(amount, 0.05, 0.35) * 0.55 * cells.base[n] * opacity;
        ink[0] = cells.ink[n * 3]; ink[1] = cells.ink[n * 3 + 1]; ink[2] = cells.ink[n * 3 + 2];
        if (alpha >= 0.012) writeSprite(out, (i + 0.5) * cell[0], (j + 0.5) * cell[1], glyphPlanetDigitFirstTile + digit, ink, alpha);
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
            const ink = gradient(palette.body, 0.55 + 0.3 * cellHash(i + 95, j), out.ink);
            writeSprite(out, x, y, digitOf(i, j, step), ink, profile * fade * 0.95 * footFade);
        }
    }
}

export function markGlyphTone({ centre, size }, x, y) {
    return clamp(0.08 + ((y - centre.y) / (size / 2) + 1) * 0.42 - (x - centre.x) / (size / 2) * 0.1);
}

// A mark cell reads as the lab's mark: a wash of the cell's colour, its dot lattice and a planet-size digit in the
// planet's glyph ink, so the silhouette stays solid between digits. The wash fills only cells wholly inside the
// mark and each lattice dot is kept only inside it, so the rounded corners and the smile follow the outline at the
// lattice's pitch rather than the cell grid. The turn narrows every cell about the mark's centre.
const markBlockTile = 20;
const markWash = 0.22;
const markLatticeAlpha = 0.45;
const markInk = [0, 0, 0], markDot = [0, 0, 0];
function writeMarkCell(out, grid, layer, mx, my, flip, digit, colour, theme, palette) {
    const { dpr } = out;
    const { centre } = layer;
    const radius = layer.size / 2;
    const cellW = grid.cell[0] / dpr, cellH = grid.cell[1] / dpr;
    const screenX = (x) => (centre.x + (x - centre.x) * flip) * dpr;
    const inside = (x, y) => markSdfAt((x - centre.x) / radius, (y - centre.y) / radius);
    if (inside(mx, my) > Math.hypot(cellW, cellH) / 2 / radius) writeSprite(out, screenX(mx), my * dpr, markBlockTile, colour, markWash * flip);
    const peak = Math.max(colour[0], colour[1], colour[2]);
    for (let c = 0; c < 3; c++) markDot[c] = theme === 'light' ? Math.round(clamp(peak - (peak - colour[c]) * 1.4, 0, 255)) : colour[c];
    for (let dy = latticePitch / 2 - cellH / 2; dy < cellH / 2; dy += latticePitch) {
        for (let dx = latticePitch / 2 - cellW / 2; dx < cellW / 2; dx += latticePitch) {
            if (inside(mx + dx, my + dy) > 0) writeSprite(out, screenX(mx + dx), (my + dy) * dpr, glyphLatticeTile, markDot, markLatticeAlpha);
        }
    }
    writeSprite(out, screenX(mx), my * dpr, glyphPlanetDigitFirstTile + digit, glyphInk(colour, theme, palette.background, markInk), 1);
}

/** Sprites one mark cell writes at most: its wash, its lattice dots and its digit. */
function markCellSprites(grid, dpr) {
    return 2 + Math.ceil(grid.cell[0] / dpr / latticePitch) * Math.ceil(grid.cell[1] / dpr / latticePitch);
}

function sampleMark(out, grid, layer, time, theme, palette) {
    const { centre, size, retypeS = 1.2, dissolve = 0, turn = 0, fill = 1, cellTimeline } = layer;
    const [cellW, cellH] = grid.cell;
    const radius = size / 2;
    const step = Math.floor(time / retypeS);
    const flip = Math.cos(clamp(turn) * 0.9);
    if (cellTimeline) {
        for (let at = 0; at < cellTimeline.length; at += 4) {
            if (time < cellTimeline[at + 2] || time >= cellTimeline[at + 3]) continue;
            const x = cellTimeline[at], y = cellTimeline[at + 1];
            const colour = gradient(palette.body, markGlyphTone(layer, x, y), out.ink);
            writeMarkCell(out, grid, layer, x, y, flip,
                digitOf(Math.floor(x * out.dpr / cellW), Math.floor(y * out.dpr / cellH), step), colour, theme, palette);
        }
        return;
    }
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
            const color = gradient(palette.body, markGlyphTone(layer, centre.x + fx * radius, y / out.dpr), out.ink);
            writeMarkCell(out, grid, layer, centre.x + fx * radius, y / out.dpr, flip, digitOf(i, j, step), color, theme, palette);
        }
    }
}

function sampleTravellers(out, layer, time, palette) {
    if (layer.stepMorphProgress !== undefined) {
        sampleStepTravellers(out, layer, time, palette);
        return;
    }
    const { particles, ink, small, alpha = 1 } = layer;
    for (let i = 0; i < particles.length; i += 8) {
        const emit = particles[i + 4], duration = particles[i + 5];
        if (time < emit || time > emit + duration) continue;
        const p = duration === 0 ? 1 : clamp((time - emit) / duration);
        const travel = smooth(p);
        const x = mix(particles[i], particles[i + 2], travel);
        const y = mix(particles[i + 1], particles[i + 3], travel) - Math.sin(Math.PI * p) * particles[i + 6];
        const tone = particles[i + 7];
        const color = ink === 'sunrise' ? gradient(palette.body, tone, out.ink) : ink;
        writeSprite(out, x * out.dpr, y * out.dpr, digitOf(i, 0, Math.floor(time * 6)) + (small ? 10 : 0), color, alpha * (color[3] ?? 255) / 255);
    }
}

const criticalDamping = (p) => 1 - (1 + 6.6 * p) * Math.exp(-6.6 * p);
const criticalEnd = criticalDamping(1);

function writeStepTraveller(out, p, glyph, color, alpha, left, top, dx, dy, bow, lift) {
    const arc = Math.sin(Math.PI * p);
    const x = left + dx * p - dy * bow * arc;
    const y = top + dy * p + (dx * bow - lift) * arc;
    writeSprite(out, x * out.dpr, y * out.dpr, glyph, color, alpha);
}

function sampleStepTravellers(out, layer, time, palette) {
    const { particles, ink, small, stepMorphProgress: progress } = layer;
    const envelope = clamp(progress / 0.05) * (1 - clamp((progress - 0.82) / 0.15));
    const tick = Math.floor(time * 6);
    for (let i = 0; i < particles.length; i += 8) {
        const start = particles[i + 4], duration = particles[i + 5];
        const p = criticalDamping(clamp((time - start) / duration)) / criticalEnd;
        const seed = particles[i + 7];
        const color = ink === 'sunrise' ? gradient(palette.body, seed, out.ink) : ink;
        const alpha = (small ? mix(0.95, 0.45, p) : 0.45) * envelope * (0.75 + 0.25 * seed) * (color[3] ?? 255) / 255;
        if (alpha < 0.01) continue;
        const left = particles[i], top = particles[i + 1];
        const dx = particles[i + 2] - left, dy = particles[i + 3] - top;
        const length = Math.hypot(dx, dy) || 1;
        const bow = (seed - 0.5) * Math.min(80, length * 0.25) / length;
        const lift = particles[i + 6];
        const glyph = digitOf(Math.round(left), Math.round(top), tick) + 10;
        if (small && p > 0.04 && p < 0.96) {
            writeStepTraveller(out, Math.max(0, p - 0.07), glyph, color, alpha * 0.45, left, top, dx, dy, bow, lift);
            writeStepTraveller(out, Math.max(0, p - 0.14), glyph, color, alpha * 0.2, left, top, dx, dy, bow, lift);
        }
        writeStepTraveller(out, p, glyph, color, alpha, left, top, dx, dy, bow, lift);
    }
}

function sampleFront(out, grid, layer, time, palette) {
    const { rect, origin, shape, front, band, ragged, alpha, ink, mode, inkMap, cover, climbProgress } = layer;
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
            const mapped = inkMap && j < inkMap.rows && i < inkMap.cols ? inkMap.rgba[(j * inkMap.cols + i) * 4 + 3] / 255 : 0;
            const inkWeight = inkMap ? mapped : 1;
            if (inkWeight === 0 && !cover) continue;
            const edge = shape === 'horizontal' ? front - y + (cellHash(i, j) - 0.5) * ragged
                : frontEdge(shape, Math.abs(x - ox), Math.abs(y - oy), front, ragged, i, j);
            if (mode === 'decode' && cover && edge >= 0) writeSprite(out, x * out.dpr, y * out.dpr, 20, cover, (cover[3] ?? 255) / 255);
            if (inkWeight === 0) continue;
            if (climbProgress !== undefined && inkWeight > 0 && cellHash(i, j) < 0.42) {
                const seed = cellHash(i, j + 7);
                const encounter = 0.55 * (1 - (y + 90) / (area.y + area.height + 310));
                const travel = (climbProgress - encounter) / 0.45;
                if (travel > 0 && travel < 1) {
                    const rise = (y + 80) * (0.55 + 0.45 * seed) * travel ** 1.4;
                    const color = ink === 'sunrise' ? gradient(palette.body, y / (out.height / out.dpr), out.ink) : ink;
                    writeSprite(out, (x + (seed - 0.5) * 6 * travel) * out.dpr, (y - rise) * out.dpr,
                        digitOf(i, j, step), color, 0.32 * Math.sin(Math.PI * travel) * (0.6 + 0.4 * seed) * inkWeight);
                }
            }
            const frontAmount = Math.max(0, 1 - Math.abs(edge) / band);
            if (frontAmount <= 0) continue;
            const color = ink === 'sunrise' ? gradient(palette.body, y / (out.height / out.dpr), out.ink) : ink;
            const amount = alpha * (climbProgress === undefined ? frontAmount : frontAmount ** 2 * (3 - 2 * frontAmount)) * inkWeight;
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
    const ink = [0, 0, 0];
    let previousBody;
    const sampleField = createGlyphFieldSampler();
    return function sample(scene, { time = 0 } = {}) {
        const { dpr, theme, view, layers } = scene;
        const width = Math.round(view.w * dpr), height = Math.round(view.h * dpr);
        const cell = (scene.cell ?? glyphPitch).map((pitch) => Math.max(1, Math.round(pitch * dpr)));
        const cols = Math.ceil(width / cell[0]), rows = Math.ceil(height / cell[1]);
        const grid = { cell, cols, rows, origin: [0, 0] };
        const capacity = layers.reduce((sum, layer) => {
            if (layer.kind === 'field') return sum;
            if (layer.kind === 'placed') return sum + layer.cells.length / 7;
            if (layer.kind === 'traveller') return sum + layer.particles.length / 8 * (layer.small && layer.stepMorphProgress !== undefined ? 3 : 1);
            if (layer.kind === 'mark') return sum + (layer.cellTimeline ? layer.cellTimeline.length / 4 : cols * rows) * markCellSprites(grid, dpr);
            if (layer.kind === 'planet') return sum + cols * rows * ((layer.ring ? 3 : 2) + Math.ceil(cell[0] / dpr / latticePitch) * Math.ceil(cell[1] / dpr / latticePitch));
            return sum + cols * rows * (layer.kind === 'front' && (layer.cover || layer.climbProgress !== undefined) ? 2 : 1);
        }, 0);
        if (capacity > storage.glyph.length) storage = { at: new Uint16Array(capacity * 2), glyph: new Uint8Array(capacity), rgba: new Uint8Array(capacity * 4) };
        const out = { ...storage, ink, dpr, width, height, count: 0 };
        const palette = PLANET_PALETTES[theme];
        let body;
        let field;
        for (const layer of layers) {
            if (layer.kind === 'field') field = layer;
            if (layer.kind === 'placed') {
                const { cells } = layer;
                for (let p = 0; p < cells.length; p += 7) {
                    ink[0] = cells[p + 3]; ink[1] = cells[p + 4]; ink[2] = cells[p + 5];
                    writeSprite(out, cells[p] * dpr, cells[p + 1] * dpr, cells[p + 2], ink, cells[p + 6]);
                }
            }
            if (layer.kind === 'planet') body = samplePlanet(out, grid, layer, time, theme, palette, previousBody);
            if (layer.kind === 'mark') sampleMark(out, grid, layer, time, theme, palette);
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
