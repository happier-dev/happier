import { PLANET_SAMPLER } from './planet.mjs';

const { gradient } = PLANET_SAMPLER;
const pitch = 6;
const fieldStep = 2;
const rippleLifeS = 2.6;
const rippleSpeed = 550;
const rippleBand = 30;
const trailTau = 1.1;
const trailRadius = 16 * 2.6;
const trailFloor = 0.015;
export const glyphFieldDurationS = 5;
export const glyphDotRadii = [0.62, 0.78, 0.92, 1.08];

export function fieldDotLayer(options) {
    return { kind: 'field', ...options };
}

const clamp = (value) => Math.min(1, Math.max(0, value));
const mix = (a, b, k) => a + (b - a) * k;
const smooth = (value) => { const k = clamp(value); return k * k * (3 - 2 * k); };

function hash(x, y, z) {
    let bits = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) | 0;
    bits = Math.imul(bits ^ (bits >>> 13), 1274126177);
    return ((bits ^ (bits >>> 16)) >>> 0) / 4294967296;
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

function createField(width, height, step, palette, seed) {
    const cols = Math.ceil(width / step), rows = Math.ceil(height / step);
    const count = cols * rows;
    const glyph = new Uint8Array(count), at = new Uint16Array(count * 2), rgba = new Uint8Array(count * 4);
    for (let j = 0; j < rows; j++) {
        const colour = gradient(palette.body, 0.04 + 0.82 * (j + 0.5) / rows);
        for (let i = 0; i < cols; i++) {
            const index = j * cols + i;
            at[index * 2] = Math.round((i + 0.5) * step);
            at[index * 2 + 1] = Math.round((j + 0.5) * step);
            glyph[index] = 21 + Math.floor(hash(i, j, seed) * glyphDotRadii.length);
            rgba.set(colour, index * 4);
            rgba[index * 4 + 3] = 255;
        }
    }
    const maskCols = Math.ceil(cols / fieldStep), maskRows = Math.ceil(rows / fieldStep);
    const mask = { width: maskCols, height: maskRows, rgba: new Uint8Array(maskCols * maskRows * 4).fill(255) };
    return { width, height, step, palette, seed, sprites: { glyph, at, rgba }, mask };
}

export function createGlyphFieldSampler() {
    let field;
    return (layer, time, width, height, dpr, theme, palette) => {
        if (!layer || layer.mode === 'off' || !width || !height) return null;
        const { quiet = [], seed = 0, strength = 1, stirs = [], ripples = [], phaseS = 0 } = layer;
        const step = Math.max(1, Math.round(pitch * dpr));
        if (!field || field.width !== width || field.height !== height || field.step !== step || field.seed !== seed || field.palette !== palette) {
            field = createField(width, height, step, palette, seed);
        }
        const { mask, sprites } = field;
        const elapsed = layer.mode === 'still' ? glyphFieldDurationS : Math.min(time, glyphFieldDurationS);
        // Integral of the calm curve. The mask reaches a fixed, continuous phase at five seconds.
        const progress = elapsed / glyphFieldDurationS;
        const phase = phaseS + 0.5 * glyphFieldDurationS * (progress - progress ** 3 + 0.5 * progress ** 4);
        const cell = step * fieldStep / dpr;
        const tint = theme === 'dark' ? 0.56 : 0.42;
        for (let j = 0; j < mask.height; j++) {
            const y = (j + 0.5) * cell;
            for (let i = 0; i < mask.width; i++) {
                const x = (i + 0.5) * cell;
                const noise = 0.68 * noise3(x / 190 + phase * 0.1, y / 150 - phase * 0.06, phase * 0.18 + seed)
                    + 0.32 * noise3(x / 70 - phase * 0.08, y / 52, phase * 0.35 + seed + 17);
                const band = 0.5 + 0.5 * Math.sin((x * 0.8 + y * 0.6) / 70 - phase * 1.3 + noise * 5);
                const patch = smooth((noise + 0.1 * (band - 0.5) - 0.36) / 0.36);
                let stirred = 0;
                if (layer.mode === 'animated') {
                    for (const stamp of stirs) {
                        const age = time - stamp.at;
                        const decay = 0.3 * Math.exp(-age / trailTau);
                        if (age < 0 || decay < trailFloor) continue;
                        stirred += (1 - smooth(Math.hypot(x - stamp.x, y - stamp.y) / trailRadius)) * decay;
                    }
                    for (const ripple of ripples) {
                        const age = time - ripple.at;
                        if (age < 0 || age >= rippleLifeS) continue;
                        const ring = Math.abs(Math.hypot(x - ripple.x, y - ripple.y) - rippleSpeed * age);
                        stirred += (1 - smooth(ring / rippleBand)) * (1 - age / rippleLifeS) ** 2;
                    }
                }
                let dip = 1;
                for (const zone of quiet) {
                    const dx = Math.max(zone.x - x, 0, x - zone.x - zone.width);
                    const dy = Math.max(zone.y - y, 0, y - zone.y - zone.height);
                    const feather = zone.feather ?? 30;
                    dip = Math.min(dip, mix(zone.level ?? 0.28, 1, smooth(Math.hypot(dx, dy) / feather)));
                }
                mask.rgba[(j * mask.width + i) * 4 + 3] = Math.round(255 * clamp(tint * strength * dip * (0.12 + 0.5 * patch + Math.min(0.6, stirred))));
            }
        }
        return { sprites, mask, maskExtent: [mask.width * step * fieldStep, mask.height * step * fieldStep] };
    };
}
