/**
 * The Supporter pass's fixed artwork (plans program, lab round 5b "Glyph sunrise × your number",
 * the approved "Number made of glyphs").
 *
 * The pass is an object, like an app icon: it keeps one material per edition whatever the app
 * theme, so these colours are deliberately not theme tokens. This file is their only home
 * (`apps/ui/AGENTS.md`, bounded art-directed exception). Graphite is Plus; paper is Lite and the
 * Supporter pack. Contrast of the pass's own text is set against these fixed grounds.
 *
 * The art is the first-open glyph field: the smile planet drawn in monospaced cells by luminance,
 * lit from below. The holder's number is drawn in the same cells' 5×7 figures, in gold, in the lit
 * band between the name row and the code, and the sky clears a small plate around it. Every glyph is
 * vector geometry rather than font text, so the field renders the same, crisp, on every platform and
 * needs no font; it is two paths (field and digits), a pure function of the number.
 * Coordinates are in a 72 × 100 box stretched to the pass, so it aligns at any width.
 *
 * This glyph art is the default of the seven styles a device can pick (`passArtStyles.ts`); the
 * palettes' face colours here (foreground, code, edge) are shared by every style.
 */

import type { SupporterPassFinishId } from '@/sync/domains/settings/registry/local/supporterPassStyleSetting';

export type PassMaterial = 'graphite' | 'paper';

/** The device's finish picks the material: graphite when dark, paper when light. */
export function passMaterialForFinish(finish: SupporterPassFinishId): PassMaterial {
    return finish === 'light' ? 'paper' : 'graphite';
}

type Stop = readonly [offset: number, color: string];

export type PassPalette = Readonly<{
    foreground: string;
    /** The mark's smile is cut out of the mark in this colour. */
    markCutout: string;
    qrBackground: string;
    qrForeground: string;
    base: readonly [string, string];
    /** Top-to-bottom ramp the glyph field is filled with (user space, 0 → 100). */
    field: readonly Stop[];
    fieldOpacity: number;
    /** The number's gold, across the band it sits in (y 45 → 66). */
    digits: readonly Stop[];
    sheen: string;
    sheenOpacity: number;
    /** Inset hairline and outer shadow; the only edge the pass has. */
    edge: string;
    shadow: string;
}>;

export const PASS_PALETTES: Readonly<Record<PassMaterial, PassPalette>> = {
    graphite: {
        foreground: '#F4F1EA',
        markCutout: '#171514',
        qrBackground: '#F4F1EA',
        qrForeground: '#111111',
        base: ['#0D0C12', '#08080B'],
        field: [[0, '#4C4778'], [0.42, '#7B5AA0'], [0.53, '#F0A04A'], [0.6, '#F8D488'], [1, '#8E3B6E']],
        fieldOpacity: 0.95,
        digits: [[0, '#FFF1C9'], [0.5, '#F8D488'], [1, '#F0A04A']],
        sheen: '#FFFFFF',
        sheenOpacity: 0.07,
        edge: 'rgba(255,255,255,0.12)',
        shadow: 'rgba(0,0,0,0.55)',
    },
    paper: {
        foreground: '#2B2722',
        markCutout: '#EFEBE3',
        qrBackground: '#FFFFFF',
        qrForeground: '#111111',
        base: ['#FBF8F2', '#EFE6D6'],
        field: [[0, '#9F96BE'], [0.42, '#B79FB8'], [0.55, '#D9734F'], [0.62, '#D9922F'], [1, '#B98A9E']],
        fieldOpacity: 0.9,
        digits: [[0, '#B8781A'], [1, '#8E4E10']],
        sheen: '#FFFFFF',
        sheenOpacity: 0.45,
        edge: 'rgba(90,66,28,0.13)',
        shadow: 'rgba(60,40,10,0.32)',
    },
};

export const PASS_ART_BOX = { width: 72, height: 100 } as const;
export const PASS_DIGIT_BAND = { y1: 45, y2: 66 } as const;

/** The mark drawn edge to edge (no internal padding), so it meets the wordmark's cap height. */
export const PASS_MARK_PATH = 'M22 0H35V25a6 6 0 0 0 6 6H59a6 6 0 0 0 6-6V0H78a22 22 0 0 1 22 22V78a22 22 0 0 1-22 22H22A22 22 0 0 1 0 78V22A22 22 0 0 1 22 0Z';
export const PASS_SMILE_PATH = 'M22 60Q50 88 78 60';

const COLS = 36;
const CELL_H = 2.85;
const ROWS = Math.ceil(PASS_ART_BOX.height / CELL_H);
/** The lab sets each row as text stretched over x 1 → 71; cells sit on that grid. */
const CELL_W = 70 / COLS;
const RAMP = ' ·.:-=+*xX#%';
/** Rows 16–22: the lit band between the name row and the code. */
const BAND = { row: 16, rows: 7 } as const;
const PLANET = { cx: 36, cy: -5, r: 64 } as const;

const FIGURES: Readonly<Record<string, readonly string[]>> = {
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

/** The lab's seeded generator, so the field's grain matches it cell for cell. */
function seeded(seed: number): () => number {
    let state = (seed * 2654435761) >>> 0 || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

const f = (n: number) => {
    const s = n.toFixed(2);
    return s.startsWith('0.') ? s.slice(1) : s.startsWith('-0.') ? `-${s.slice(2)}` : s;
};

/** A filled polygon with one fixed winding, so overlapping strokes of a glyph union under nonzero. */
function polygon(points: ReadonlyArray<readonly [number, number]>): string {
    let area = 0;
    for (let index = 0; index < points.length; index++) {
        const [x1, y1] = points[index]!;
        const [x2, y2] = points[(index + 1) % points.length]!;
        area += x1 * y2 - x2 * y1;
    }
    const ordered = area < 0 ? [...points].reverse() : points;
    let d = `M${f(ordered[0]![0])} ${f(ordered[0]![1])}`;
    for (let index = 1; index < ordered.length; index++) {
        d += `l${f(ordered[index]![0] - ordered[index - 1]![0])} ${f(ordered[index]![1] - ordered[index - 1]![1])}`;
    }
    return `${d}z`;
}

function bar(x1: number, y1: number, x2: number, y2: number, weight: number): string {
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = (-(y2 - y1) / length) * (weight / 2);
    const ny = ((x2 - x1) / length) * (weight / 2);
    return polygon([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]);
}

function dot(x: number, y: number, r: number): string {
    const points: Array<readonly [number, number]> = [];
    for (let k = 0; k < 8; k++) {
        const a = (Math.PI / 4) * k + Math.PI / 8;
        points.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    return polygon(points);
}

/** One monospaced glyph, drawn on its baseline at cell centre `cx`. */
function glyph(char: string, cx: number, baseline: number, weight: number): string {
    const cap = baseline - 1.84;
    const xHeight = baseline - 1.36;
    const axis = baseline - 0.72;
    switch (char) {
        case '·': return dot(cx, axis, 0.2);
        case '.': return dot(cx, baseline - 0.22, 0.22);
        case ':': return dot(cx, baseline - 0.22, 0.21) + dot(cx, xHeight + 0.14, 0.21);
        case '-': return bar(cx - 0.55, axis, cx + 0.55, axis, weight);
        case '=': return bar(cx - 0.6, axis - 0.32, cx + 0.6, axis - 0.32, weight) + bar(cx - 0.6, axis + 0.32, cx + 0.6, axis + 0.32, weight);
        case '+': return bar(cx - 0.6, axis, cx + 0.6, axis, weight) + bar(cx, axis - 0.6, cx, axis + 0.6, weight);
        case '*': {
            const y = cap + 0.62;
            return bar(cx, y - 0.58, cx, y + 0.58, weight)
                + bar(cx - 0.5, y - 0.29, cx + 0.5, y + 0.29, weight)
                + bar(cx - 0.5, y + 0.29, cx + 0.5, y - 0.29, weight);
        }
        case 'x': return bar(cx - 0.55, xHeight, cx + 0.55, baseline, weight) + bar(cx + 0.55, xHeight, cx - 0.55, baseline, weight);
        case 'X': return bar(cx - 0.65, cap, cx + 0.65, baseline, weight) + bar(cx + 0.65, cap, cx - 0.65, baseline, weight);
        case '#': return bar(cx - 0.24, cap + 0.12, cx - 0.42, baseline, weight)
            + bar(cx + 0.42, cap + 0.12, cx + 0.24, baseline, weight)
            + bar(cx - 0.75, cap + 0.58, cx + 0.75, cap + 0.58, weight)
            + bar(cx - 0.75, baseline - 0.52, cx + 0.75, baseline - 0.52, weight);
        case '%': return bar(cx + 0.65, cap, cx - 0.65, baseline, weight)
            + dot(cx - 0.42, cap + 0.4, 0.3)
            + dot(cx + 0.42, baseline - 0.38, 0.3);
        default: return '';
    }
}

/** The padded number's lit cells, centred on the band. */
function numberCells(number: number): Readonly<{ on: ReadonlySet<number>; c0: number; c1: number }> {
    const digits = String(number).padStart(4, '0');
    const width = digits.length * 6 - 1;
    const c0 = Math.floor((COLS - width) / 2);
    const on = new Set<number>();
    [...digits].forEach((digit, k) => FIGURES[digit]?.forEach((line, row) => [...line].forEach((bit, col) => {
        if (bit === '1') on.add((BAND.row + row) * COLS + c0 + k * 6 + col);
    })));
    return { on, c0, c1: c0 + width - 1 };
}

export type PassGlyphPaths = Readonly<{ field: string; digits: string }>;

const glyphCache = new Map<string, PassGlyphPaths>();

/**
 * The glyph field and, with a number, the number made of its cells. Geometry only, the same for
 * both materials; cached per number (a client shows one or two).
 */
export function passGlyphPaths(number: number | null): PassGlyphPaths {
    const key = number === null ? 'blank' : String(number);
    const cached = glyphCache.get(key);
    if (cached) return cached;
    const cells = number === null ? null : numberCells(number);
    const random = seeded(7);
    let field = '';
    let digits = '';
    for (let row = 0; row < ROWS; row++) {
        const y = row * CELL_H + CELL_H * 0.5;
        const baseline = row * CELL_H + CELL_H * 0.82;
        for (let col = 0; col < COLS; col++) {
            const x = col * 2 + 1;
            const distance = Math.hypot(x - PLANET.cx, y - PLANET.cy);
            let light: number;
            if (distance < PLANET.r) {
                const down = Math.max(0, (y - PLANET.cy) / distance);
                light = Math.pow(down, 2.6) * Math.pow(Math.max(0, 1 - (PLANET.r - distance) / 13), 1.3) * 1.05;
            } else {
                light = 0.9 * Math.exp(-Math.hypot((x - PLANET.cx) / 1.7, y - 62) / 8) + 0.45 * Math.exp(-(distance - PLANET.r) / 2.4);
            }
            const noise = random();
            light = Math.min(0.999, Math.max(0, light + (light > 0.08 ? (noise - 0.5) * 0.08 : noise < 0.03 ? 0.1 : 0)));
            const cx = 1 + (col + 0.5) * CELL_W;
            if (cells?.on.has(row * COLS + col)) {
                digits += glyph('#', cx, baseline, 0.32);
                continue;
            }
            const plate = cells !== null
                && row >= BAND.row - 1 && row <= BAND.row + BAND.rows
                && col >= cells.c0 - 1 && col <= cells.c1 + 1;
            field += glyph(RAMP[Math.floor(light * (plate ? 0.4 : 1) * RAMP.length)] ?? ' ', cx, baseline, 0.24);
        }
    }
    const paths = { field, digits };
    glyphCache.set(key, paths);
    return paths;
}
