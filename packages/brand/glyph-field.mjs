import { PLANET_SAMPLER, PLANET_SCENE_RENDERER } from './planet.mjs';

const { gradient, lightForReveal } = PLANET_SAMPLER;
const { sceneHash: hash } = PLANET_SCENE_RENDERER;
const pitch = 6;
const fieldStep = 2;
const rippleLifeS = 2.6;
const rippleSpeed = 550;
const rippleBand = 30;
const trailTau = 1.1;
export const glyphFieldTrailCell = 16;
const trailRadius = glyphFieldTrailCell * 2.6;
const trailFloor = 0.015;
export const glyphFieldTrailLifeS = trailTau * Math.log(0.3 / trailFloor);
export const glyphFieldRippleLifeS = rippleLifeS;
export const glyphFieldDurationS = 5;
export const glyphDotRadii = [0.62, 0.78, 0.92, 1.08];

export function fieldDotLayer(options) {
    return { kind: 'field', ...options };
}

const clamp = (value) => Math.min(1, Math.max(0, value));
const mix = (a, b, k) => a + (b - a) * k;
const smooth = (value) => { const k = clamp(value); return k * k * (3 - 2 * k); };
const empty = Object.freeze([]);
const planetLight = lightForReveal(1);

export function glyphFieldPhase(seconds) {
    const progress = clamp(seconds / glyphFieldDurationS);
    return 0.5 * glyphFieldDurationS * (progress - progress ** 3 + 0.5 * progress ** 4);
}

function noise3(x, y, z) {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const u = smooth(x - i), v = smooth(y - j), w = smooth(z - k);
    return mix(
        mix(mix(hash(i, j, k), hash(i + 1, j, k), u), mix(hash(i, j + 1, k), hash(i + 1, j + 1, k), u), v),
        mix(mix(hash(i, j, k + 1), hash(i + 1, j, k + 1), u), mix(hash(i, j + 1, k + 1), hash(i + 1, j + 1, k + 1), u), v),
        w,
    );
}

// The light theme's deep ink: each pastel keeps its hue and is pulled down to a saturated ink.
function deepInk([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) { h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    if (h > 28 && h < 62) h -= (h - 28) * 0.35;
    const S = Math.min(0.96, s * 1.15 + 0.3), L = 0.15 + 0.17 * l;
    const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = L - c / 2;
    const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((R + m) * 255), Math.round((G + m) * 255), Math.round((B + m) * 255)];
}

// The website's quiet material: neutral ink, with the planet's hues drifting in by position in slow, wide bands.
const fieldInk = { light: [52, 44, 38], dark: [236, 230, 220] };
const fieldHueTint = 0.3;

function createField(width, height, step, palette, seed, theme, dpr) {
    const cols = Math.ceil(width / step), rows = Math.ceil(height / step);
    const count = cols * rows;
    const glyph = new Uint8Array(count), at = new Uint16Array(count * 2), rgba = new Uint8Array(count * 4);
    const dark = theme !== 'light';
    const ink = fieldInk[dark ? 'dark' : 'light'];
    const hues = Array.from({ length: 65 }, (_, k) => {
        const c = gradient(palette.body, 0.04 + (k / 64) * 0.82);
        return dark ? c.map((v) => v + (255 - v) * 0.34) : deepInk(c);
    });
    for (let j = 0; j < rows; j++) {
        const y = (j + 0.5) * step / dpr;
        for (let i = 0; i < cols; i++) {
            const index = j * cols + i;
            const x = (i + 0.5) * step / dpr;
            const drift = Math.sin(x * 0.0021 + y * 0.0013) + Math.sin(y * 0.0017 - x * 0.0009 + 1.7);
            const tint = smooth((Math.abs(drift) - 0.1) / 1.05) * 0.72 * fieldHueTint;
            let along = (0.5 + 0.3 * drift) % 1; if (along < 0) along += 1;
            const hue = hues[Math.round((along < 0.5 ? along * 2 : 2 - along * 2) * 64)];
            at[index * 2] = Math.round((i + 0.5) * step);
            at[index * 2 + 1] = Math.round((j + 0.5) * step);
            glyph[index] = 21 + Math.floor(hash(i, j, seed) * glyphDotRadii.length);
            for (let c = 0; c < 3; c++) rgba[index * 4 + c] = Math.round(ink[c] + (hue[c] - ink[c]) * tint);
            rgba[index * 4 + 3] = 255;
        }
    }
    const maskCols = Math.ceil(cols / fieldStep), maskRows = Math.ceil(rows / fieldStep);
    const mask = { width: maskCols, height: maskRows, rgba: new Uint8Array(maskCols * maskRows * 4).fill(255) };
    const frame = { sprites: { glyph, at, rgba }, mask, maskExtent: [mask.width * step * fieldStep, mask.height * step * fieldStep], revision: 0 };
    return { width, height, step, palette, seed, theme, frame, phase: NaN, quiet: null, strength: NaN, planet: '', active: false };
}

export function createGlyphFieldSampler() {
    let field;
    return (layer, time, width, height, dpr, theme, palette) => {
        if (!layer || layer.mode === 'off' || !width || !height) return null;
        const { quiet = empty, seed = 0, strength = 1, stirs = empty, ripples = empty, phaseS = 0, planet } = layer;
        const step = Math.max(1, Math.round(pitch * dpr));
        if (!field || field.width !== width || field.height !== height || field.step !== step || field.seed !== seed || field.palette !== palette || field.theme !== theme) {
            field = createField(width, height, step, palette, seed, theme, dpr);
        }
        const planetKey = planet ? `${planet.cx}/${planet.cy}/${planet.R}` : '';
        const stampTime = time = layer.mode === 'still' ? glyphFieldDurationS : layer.stampTimeS ?? time;
        const { mask } = field.frame;
        const phase = phaseS + glyphFieldPhase(layer.mode === 'still' ? time : layer.elapsedS ?? time);
        const active = layer.mode === 'animated' && (
            stirs.some(stamp => time >= stamp.at && time - stamp.at < glyphFieldTrailLifeS)
            || ripples.some(ripple => time >= ripple.at && time - ripple.at < rippleLifeS));
        if (!active && !field.active && phase === field.phase && quiet === field.quiet && strength === field.strength && planetKey === field.planet) return field.frame;
        field.active = active;
        field.phase = phase;
        field.quiet = quiet;
        field.strength = strength;
        field.planet = planetKey;
        field.frame.revision++;
        const cell = step * fieldStep / dpr;
        const maxAlpha = theme === 'dark' ? 0.56 : 0.42;
        const light = planetLight;
        for (let j = 0; j < mask.height; j++) {
            const y = (j + 0.5) * cell;
            for (let i = 0; i < mask.width; i++) {
                const x = (i + 0.5) * cell;
                const noise = 0.68 * noise3(x / 190 + phase * 0.1, y / 150 - phase * 0.06, phase * 0.18 + seed)
                    + 0.32 * noise3(x / 70 - phase * 0.08, y / 52, phase * 0.35 + seed + 17);
                const band = 0.5 + 0.5 * Math.sin((x * 0.8 + y * 0.6) / 70 - phase * 1.3 + noise * 5);
                const patch = smooth((noise + 0.1 * (band - 0.5) - 0.36) / 0.36);
                // The planet's halo is already dots on its own lattice: the field gives way, so the two grids never beat.
                let near = 0, beside = 1;
                if (planet) {
                    const dx = x - planet.cx, dy = y - planet.cy, d = Math.hypot(dx, dy) || 1, q = d / planet.R;
                    beside = smooth((q - 0.97) / 0.19);
                    if (q < 5) {
                        const altitude = Math.max(0, q - 1);
                        const facing = clamp(((dx * light[0] + dy * light[1]) / d) * 0.8 + 0.5);
                        near = (0.62 * Math.exp(-altitude * 3.4) + 0.38 * Math.exp(-altitude * 1.05)) * (0.42 + 0.58 * facing);
                    }
                }
                let alpha = maxAlpha * patch * patch * (0.3 + 0.7 * (band + (1 - band) * near * 0.45)) * (1 - clamp(near * 2.4));
                if (active) {
                    let trail = 0, ring = 0;
                    for (const stamp of stirs) {
                        const age = stampTime - stamp.at;
                        const decay = 0.3 * Math.exp(-age / trailTau);
                        if (age < 0 || decay < trailFloor) continue;
                        trail += (1 - smooth(Math.hypot(x - stamp.x, y - stamp.y) / trailRadius)) * decay;
                    }
                    for (const ripple of ripples) {
                        const age = stampTime - ripple.at;
                        if (age < 0 || age >= rippleLifeS) continue;
                        const distance = Math.abs(Math.hypot(x - ripple.x, y - ripple.y) - rippleSpeed * age);
                        ring += (1 - smooth(distance / rippleBand)) * (1 - age / rippleLifeS) ** 2;
                    }
                    alpha += maxAlpha * Math.min(0.6, trail) * (0.8 + 1.2 * patch) * 0.85 + Math.min(1, ring) * (0.5 + 0.5 * patch);
                }
                let dip = 1;
                for (const zone of quiet) {
                    const dx = Math.max(zone.x - x, 0, x - zone.x - zone.width);
                    const dy = Math.max(zone.y - y, 0, y - zone.y - zone.height);
                    // Copy sits on a calm column whose edge falls off softly, never a visible box (lab dip, ~150 px).
                    const feather = zone.feather ?? 150;
                    dip = Math.min(dip, mix(zone.level ?? 0.28, 1, smooth(Math.hypot(dx, dy) / feather)));
                }
                mask.rgba[(j * mask.width + i) * 4 + 3] = Math.round(255 * clamp(alpha * beside * strength * dip));
            }
        }
        return field.frame;
    };
}
