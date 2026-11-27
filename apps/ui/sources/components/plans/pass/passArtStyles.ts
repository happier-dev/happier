/**
 * The seven artworks a Supporter pass can wear (lab round 5b, `screens-sp5.js`, the owner's picks).
 *
 * The pass keeps one grid, one face and two materials; only the art behind the content changes.
 * Each art here is a pure function of its style, the material and, for the numbered arts, the
 * holder's number: no new data, no per-person asset, nothing stored. It returns a small vector
 * description (gradients and layers) that `SupporterPass` draws with react-native-svg, so every art
 * renders razor-sharp on web and native. Dot and glyph art is a handful of paths per colour, never
 * thousands of nodes. Coordinates are the 72 × 100 pass box.
 *
 * Like `passArt.ts`, the colours are the object's own fixed materials, not theme tokens; this file
 * and `passArt.ts` are their only home (`apps/ui/AGENTS.md`, bounded art-directed exception).
 */

import type { SupporterPassStyleId } from '@/sync/domains/settings/registry/local/supporterPassStyleSetting';

import { formatSupporterNumber } from '../planSurfaceCopy';
import { PASS_ART_BOX, PASS_DIGIT_BAND, PASS_PALETTES, passGlyphPaths, type PassMaterial } from './passArt';

type Stop = readonly [offset: number, color: string, opacity?: number];

/** A colour, or one of the art's own gradients by its local id. */
export type PassPaint = string | Readonly<{ gradient: string }>;

export type PassArtGradient =
    | Readonly<{ kind: 'linear'; id: string; units: 'box' | 'user'; x1: number; y1: number; x2: number; y2: number; stops: readonly Stop[] }>
    /** Always in pass units; `scaleY` squashes it about its centre into an ellipse. */
    | Readonly<{ kind: 'radial'; id: string; cx: number; cy: number; r: number; scaleY?: number; stops: readonly Stop[] }>;

export type PassArtLayer =
    | Readonly<{ kind: 'fill'; paint: PassPaint; opacity?: number }>
    | Readonly<{ kind: 'path'; d: string; fill?: PassPaint; stroke?: PassPaint; strokeWidth?: number; opacity?: number }>
    | Readonly<{ kind: 'circle'; cx: number; cy: number; r: number; fill?: PassPaint; stroke?: PassPaint; strokeWidth?: number; opacity?: number }>
    | Readonly<{
        kind: 'text';
        x: number;
        y: number;
        text: string;
        font: 'display' | 'mono';
        size: number;
        anchor: 'start' | 'middle' | 'end';
        letterSpacing?: number;
        fill?: PassPaint;
        stroke?: PassPaint;
        strokeWidth?: number;
        opacity?: number;
    }>
    /** Layers seen through a luminance mask filled with the gradient `mask`. */
    | Readonly<{ kind: 'masked'; mask: string; layers: readonly PassArtLayer[] }>;

export type PassArtSpec = Readonly<{ gradients: readonly PassArtGradient[]; layers: readonly PassArtLayer[] }>;

const WHITE = '#FFFFFF';
const BLACK = '#000000';
const { width: W, height: H } = PASS_ART_BOX;

const f2 = (n: number) => n.toFixed(2);
const paint = (gradient: string): PassPaint => ({ gradient });

/** The lab's seeded generator, so each art matches its lab drawing dot for dot. */
function seeded(seed: number): () => number {
    let state = (seed * 2654435761) >>> 0 || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

/** A circle as a path segment, so thousands of dots share one path per colour. */
function dot(x: number, y: number, r: number): string {
    return `M${f2(x - r)} ${f2(y)}a${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0a${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0`;
}

function linear(id: string, stops: readonly Stop[], x1 = 0, y1 = 0, x2 = 0, y2 = 1): PassArtGradient {
    return { kind: 'linear', id, units: 'box', x1, y1, x2, y2, stops };
}

/** The diagonal sheen every pass carries, as if light crossed the material. */
function sheen(id: string, strength: number, at: readonly [number, number, number, number] = [0.3, 0.47, 0.53, 0.68], tail = 0.55): PassArtGradient {
    return linear(id, [[at[0], WHITE, 0], [at[1], WHITE, strength], [at[2], WHITE, strength * tail], [at[3], WHITE, 0]], 0, 0, 1, 1);
}

const fill = (id: string, opacity?: number): PassArtLayer => ({ kind: 'fill', paint: paint(id), opacity });

function buckets(paths: readonly string[][], colors: readonly string[], opacities: readonly (number | undefined)[] = []): PassArtLayer[] {
    const layers: PassArtLayer[] = [];
    paths.forEach((segments, k) => {
        if (segments.length) layers.push({ kind: 'path', d: segments.join(''), fill: colors[k], opacity: opacities[k] });
    });
    return layers;
}

/* 1 · Number made of glyphs (the approved launch art) and 2 · Glyph sunrise (the same field, no number). */
function glyphArt(material: PassMaterial, number: number | null): PassArtSpec {
    const palette = PASS_PALETTES[material];
    const glyphs = passGlyphPaths(number);
    return {
        gradients: [
            linear('base', [[0, palette.base[0]], [1, palette.base[1]]]),
            { kind: 'linear', id: 'field', units: 'user', x1: 0, y1: 0, x2: 0, y2: H, stops: palette.field },
            { kind: 'linear', id: 'digits', units: 'user', x1: 0, y1: PASS_DIGIT_BAND.y1, x2: 0, y2: PASS_DIGIT_BAND.y2, stops: palette.digits },
            sheen('sheen', palette.sheenOpacity),
        ],
        layers: [
            fill('base'),
            { kind: 'path', d: glyphs.field, fill: paint('field'), opacity: palette.fieldOpacity },
            ...(glyphs.digits ? [{ kind: 'path', d: glyphs.digits, fill: paint('digits') } as const] : []),
            fill('sheen'),
        ],
    };
}

/* 3 · Smile planet: a planet hangs from above; its lower limb, lit from below in dots, is the smile. */
const SMILE = { cx: 36, cy: -5, r: 64, step: 1.12 } as const;
function smilePlanet(material: PassMaterial): PassArtSpec {
    const paper = material === 'paper';
    const tones = paper
        ? { tex: ['#8C8272', 0.16] as const, lit: ['#9E86B4', '#C06C86', '#D9734F', '#D9922F', '#C9871F'] }
        : { tex: ['#9A93B8', 0.2] as const, lit: ['#5E4A9A', '#A24E86', '#DA6A5C', '#F0A04A', '#F8D488'] };
    const g = paper
        ? { base: ['#F6EFE3', '#EDE3D2', '#E2D5BF'], disc: ['#FFF6E8', '#FCF8F1', '#F7F2EA'], glow: ['#F2A65A', 0.5, '#E596A6', 0.18] as const, corner: ['#BDB5E4', 0.36] as const, sheen: 0.5, rim: 'rgba(120,90,40,0.2)' }
        : { base: ['#121019', '#0B0A0F', '#08080B'], disc: ['#2C2340', '#181522', '#0D0C12'], glow: ['#F2A24E', 0.36, '#8E3B6E', 0.2] as const, corner: ['#22336A', 0.42] as const, sheen: 0.085, rim: 'rgba(255,255,255,0.06)' };
    const { cx, cy, r, step } = SMILE;
    const dots: string[][] = Array.from({ length: 6 }, () => []);
    for (let j = 0, y = 0.4; y < cy + r; j++, y += step * 0.866) {
        for (let x = (j % 2) * step / 2 + 0.3; x < W; x += step) {
            const d = Math.hypot(x - cx, y - cy);
            if (d > r - 0.35) continue;
            const down = Math.max(0, (y - cy) / d);
            const lit = Math.pow(down, 3.2) * Math.pow(Math.max(0, 1 - (r - d) / 8), 1.5);
            const k = lit < 0.035 ? 0 : 1 + Math.min(4, Math.floor(lit * 5));
            dots[k]!.push(dot(x, y, k ? 0.17 + 0.36 * lit : 0.15));
        }
    }
    const glowY = cy + r + 2;
    return {
        gradients: [
            linear('base', [[0, g.base[0]!], [0.55, g.base[1]!], [1, g.base[2]!]], 0, 0, 0.25, 1),
            { kind: 'radial', id: 'corner', cx: 4, cy: 104, r: 46, stops: [[0, g.corner[0], g.corner[1]], [1, g.corner[0], 0]] },
            { kind: 'radial', id: 'glow', cx, cy: glowY, r: 40, scaleY: 0.62, stops: [[0, g.glow[0], g.glow[1]], [0.45, g.glow[2], g.glow[3]], [1, g.glow[2], 0]] },
            { kind: 'radial', id: 'disc', cx, cy: cy + r, r: r * 1.15, stops: [[0, g.disc[0]!], [0.4, g.disc[1]!], [1, g.disc[2]!]] },
            sheen('sheen', g.sheen, [0.3, 0.47, 0.52, 0.66], 0.6),
        ],
        layers: [
            fill('base'),
            fill('corner'),
            fill('glow'),
            { kind: 'circle', cx, cy, r, fill: paint('disc') },
            { kind: 'circle', cx, cy, r: r - 0.15, stroke: g.rim, strokeWidth: 0.3 },
            ...buckets(dots, [tones.tex[0], ...tones.lit], [tones.tex[1]]),
            fill('sheen'),
        ],
    };
}

/* 4 · Dawn halftone: the sky as a print, night at the top to dawn at the horizon, a planet rising under the code. */
function dawnHalftone(material: PassMaterial): PassArtSpec {
    const paper = material === 'paper';
    const planet = { cx: 36, cy: 124, r: 50 };
    const step = 1.25;
    const dots: string[][] = Array.from({ length: 6 }, () => []);
    for (let j = 0, y = 0.6; y < H; j++, y += step * 0.866) {
        for (let x = (j % 2) * step / 2 + 0.3; x < W; x += step) {
            const d = Math.hypot(x - planet.cx, y - planet.cy);
            if (d < planet.r) continue;
            const t = Math.pow(y / H, 1.7);
            const near = Math.max(0, 1 - (d - planet.r) / 16);
            const light = Math.min(1, 0.06 + 0.55 * t + 0.5 * near * near);
            dots[Math.min(5, Math.floor((y / H) * 4 + near * 2.2))]!.push(dot(x, y, 0.08 + 0.5 * light));
        }
    }
    const colors = paper
        ? ['#C9C2E3', '#D7B5CF', '#E6A6A3', '#EDA27A', '#EFB36A', '#E7A23E']
        : ['#2E3570', '#5A3F82', '#9A4A86', '#D86A62', '#F09A55', '#F8C878'];
    const opacities = paper ? [0.55, 0.6, 0.7, 0.8, 0.85, 0.95] : [0.7, 0.75, 0.8, 0.9, 0.95, 1];
    return {
        gradients: [
            linear('base', paper ? [[0, '#FBF8F2'], [1, '#F3E7D6']] : [[0, '#07080F'], [1, '#120C14']]),
            { kind: 'radial', id: 'planet', cx: planet.cx, cy: planet.cy - planet.r, r: planet.r * 1.2, stops: paper ? [[0, '#FFF7EA'], [1, '#EFE7DA']] : [[0, '#231C2E'], [1, '#0A090D']] },
            sheen('sheen', paper ? 0.45 : 0.07),
        ],
        layers: [
            fill('base'),
            ...buckets(dots, colors, opacities),
            { kind: 'circle', cx: planet.cx, cy: planet.cy, r: planet.r, fill: paint('planet') },
            { kind: 'circle', cx: planet.cx, cy: planet.cy, r: planet.r, stroke: paper ? '#E0A23A' : '#F8D488', strokeWidth: 0.35, opacity: 0.9 },
            fill('sheen'),
        ],
    };
}

/* 5 · Holo foil: a diffraction band crossing the pass, fine grating lines and a few glints. */
function holoFoil(material: PassMaterial): PassArtSpec {
    const paper = material === 'paper';
    const random = seeded(11);
    let grating = '';
    for (let i = -100; i < 172; i += 0.9) grating += `M${f2(i)} 0L${f2(i - 60)} ${H}`;
    let glints = '';
    for (let k = 0; k < 26; k++) {
        const x = random() * W;
        const y = 48 + random() * 48;
        const s = 0.3 + Math.pow(random(), 2) * 1.1;
        glints += `M${f2(x)} ${f2(y - s)}L${f2(x + s * 0.22)} ${f2(y)}L${f2(x)} ${f2(y + s)}L${f2(x - s * 0.22)} ${f2(y)}Z`
            + `M${f2(x - s)} ${f2(y)}L${f2(x)} ${f2(y + s * 0.22)}L${f2(x + s)} ${f2(y)}L${f2(x)} ${f2(y - s * 0.22)}Z`;
    }
    return {
        gradients: [
            linear('base', paper ? [[0, '#F7F5F9'], [1, '#ECE8EF']] : [[0, '#0B0B0F'], [1, '#060608']]),
            linear('iri', [[0, '#5EE7DF'], [0.2, '#8E6CF2'], [0.4, '#FF6A9A'], [0.6, '#FFD36B'], [0.8, '#7BE0A6'], [1, '#5EE7DF']], 0, 0, 1, 0.35),
            linear('band', [[0.18, WHITE, 0], [0.42, WHITE, 1], [0.62, WHITE, 0.8], [0.86, WHITE, 0]], 0, 0, 0.8, 1),
            sheen('sheen', paper ? 0.5 : 0.1),
        ],
        layers: [
            fill('base'),
            {
                kind: 'masked',
                mask: 'band',
                layers: [
                    fill('iri', paper ? 0.5 : 0.42),
                    { kind: 'path', d: grating, stroke: WHITE, strokeWidth: 0.18, opacity: paper ? 0.55 : 0.1 },
                ],
            },
            { kind: 'path', d: glints, fill: WHITE, opacity: paper ? 0.9 : 0.75 },
            fill('sheen'),
        ],
    };
}

/* 6 · Star chart: a printed sky map with a graticule; the holder's number is one marked star. */
const CONSTELLATION: ReadonlyArray<readonly [number, number]> = [[9, 52], [17, 49], [24, 56], [31, 53], [27, 64], [18, 68]];
function starChart(material: PassMaterial, number: number | null): PassArtSpec {
    const paper = material === 'paper';
    const ink = paper ? '#2B3A55' : '#E8ECF8';
    const gold = paper ? '#C9871F' : '#F6C46B';
    const random = seeded(3);
    let grid = '';
    for (let k = 0; k < 9; k++) grid += dot(36, -46, 70 + k * 11);
    for (let k = -5; k <= 5; k++) {
        const a = Math.PI / 2 + k * 0.16;
        grid += `M36 -46L${f2(36 + 200 * Math.cos(a))} ${f2(-46 + 200 * Math.sin(a))}`;
    }
    const stars: string[][] = [[], [], []];
    for (let k = 0; k < 160; k++) {
        const x = random() * W;
        const y = random() * H;
        let magnitude = Math.pow(random(), 4);
        if (y < 46) magnitude = Math.min(magnitude, 0.08);
        stars[magnitude > 0.5 ? 2 : magnitude > 0.12 ? 1 : 0]!.push(dot(x, y, 0.1 + magnitude * 0.55));
    }
    const gradients: PassArtGradient[] = [
        linear('base', paper ? [[0, '#FAF6EC'], [1, '#EEE4D0']] : [[0, '#0B1020'], [1, '#06070D']]),
        sheen('sheen', paper ? 0.4 : 0.07),
    ];
    const layers: PassArtLayer[] = [
        fill('base'),
        { kind: 'path', d: grid, stroke: ink, strokeWidth: 0.1, opacity: paper ? 0.22 : 0.16 },
        ...buckets(stars, [ink, ink, ink], [0.35, paper ? 0.6 : 0.65, 0.95]),
        { kind: 'path', d: `M${CONSTELLATION.map((point) => point.join(' ')).join('L')}`, stroke: ink, strokeWidth: 0.12, opacity: 0.35 },
        { kind: 'path', d: CONSTELLATION.map(([x, y]) => dot(x, y, 0.38)).join(''), fill: ink },
    ];
    if (number !== null) {
        // Placed by the number, so each holder's star sits somewhere of its own.
        const place = seeded(number);
        const mx = 44 + place() * 20;
        const my = 50 + place() * 14;
        gradients.push({ kind: 'radial', id: 'mark', cx: mx, cy: my, r: 10, stops: [[0, '#F6C46B', paper ? 0.35 : 0.3], [1, '#F6C46B', 0]] });
        layers.push(
            fill('mark'),
            { kind: 'circle', cx: mx, cy: my, r: 2.2, stroke: gold, strokeWidth: 0.16 },
            { kind: 'path', d: dot(mx, my, 0.75), fill: paper ? '#C9871F' : '#F8D488' },
            // The label reads to the star's right, or to its left when the star sits near the edge.
            {
                kind: 'text', x: mx > 54 ? mx - 3 : mx + 3, y: my + 0.7, text: `No. ${formatSupporterNumber(number)}`,
                font: 'mono', size: 1.9, anchor: mx > 54 ? 'end' : 'start', letterSpacing: 0.2, fill: paper ? '#8A5E12' : '#F6DE97',
            },
        );
    }
    layers.push(fill('sheen'));
    return { gradients, layers };
}

/* 7 · Embossed number: the holder's number pressed into the material, tone on tone; nothing else. */
function embossedNumber(material: PassMaterial, number: number | null): PassArtSpec {
    const paper = material === 'paper';
    const layers: PassArtLayer[] = [fill('base'), fill('vignette')];
    if (number !== null) {
        const text = String(number);
        // Sized for the app's Inter (wider than the lab's Inter Tight) so the digits bleed only
        // slightly past the edges, as in the lab, at two, three and four digits.
        const size = text.length > 3 ? 32 : text.length > 2 ? 42 : 60;
        const press = (dx: number, dy: number, rest: Partial<Extract<PassArtLayer, { kind: 'text' }>>): PassArtLayer => ({
            kind: 'text', x: W / 2 + dx, y: 96 + dy, text, font: 'display', size, anchor: 'middle', letterSpacing: -3, ...rest,
        });
        layers.push(...(paper
            ? [
                press(-0.35, -0.35, { fill: 'none', stroke: WHITE, strokeWidth: 0.5, opacity: 0.95 }),
                press(0.35, 0.35, { fill: 'none', stroke: '#5A421C', strokeWidth: 0.4, opacity: 0.22 }),
                press(0, 0, { fill: '#EDE4D4' }),
            ]
            : [
                press(-0.35, -0.35, { fill: 'none', stroke: WHITE, strokeWidth: 0.45, opacity: 0.2 }),
                press(0.35, 0.35, { fill: 'none', stroke: BLACK, strokeWidth: 0.5, opacity: 0.85 }),
                press(0, 0, { fill: '#1B1A21' }),
            ]));
    }
    layers.push(fill('sheen'));
    return {
        gradients: [
            linear('base', paper ? [[0, '#F8F3EA'], [1, '#ECE3D3']] : [[0, '#16151B'], [1, '#0B0B0E']]),
            { kind: 'radial', id: 'vignette', cx: 36, cy: 40, r: 70, stops: [[0, BLACK, 0], [1, BLACK, paper ? 0.08 : 0.45]] },
            sheen('sheen', paper ? 0.45 : 0.08),
        ],
        layers,
    };
}

const STYLES: Readonly<Record<SupporterPassStyleId, Readonly<{ numbered: boolean; draw: (material: PassMaterial, number: number | null) => PassArtSpec }>>> = {
    'glyph-number': { numbered: true, draw: glyphArt },
    'glyph-sunrise': { numbered: false, draw: (material) => glyphArt(material, null) },
    'smile-planet': { numbered: false, draw: smilePlanet },
    'dawn-halftone': { numbered: false, draw: dawnHalftone },
    'holo-foil': { numbered: false, draw: holoFoil },
    'star-chart': { numbered: true, draw: starChart },
    'embossed-number': { numbered: true, draw: embossedNumber },
};

const artCache = new Map<string, PassArtSpec>();

/** The art's cache and gradient key: the number only counts for the arts that draw it. */
export function passArtKey(style: SupporterPassStyleId, material: PassMaterial, number: number | null): string {
    return `${style}-${material}-${STYLES[style].numbered ? number ?? 'blank' : 'any'}`;
}

/** One style's art for one material and number; cached, since a client shows only a few passes. */
export function passArtSpec(style: SupporterPassStyleId, material: PassMaterial, number: number | null): PassArtSpec {
    const key = passArtKey(style, material, number);
    const cached = artCache.get(key);
    if (cached) return cached;
    const art = STYLES[style].draw(material, number);
    artCache.set(key, art);
    return art;
}

/**
 * Each style's two-tone swatch for the style switcher: the art's ground and its signature light,
 * per material, so the swatch reads as the pass it picks.
 */
export const PASS_STYLE_SWATCHES: Readonly<Record<SupporterPassStyleId, Readonly<Record<PassMaterial, readonly [ground: string, light: string]>>>> = {
    'glyph-number': { graphite: ['#0D0C12', '#F8D488'], paper: ['#F4EDE1', '#B8781A'] },
    'glyph-sunrise': { graphite: ['#4C4778', '#F0A04A'], paper: ['#B79FB8', '#D9734F'] },
    'smile-planet': { graphite: ['#181522', '#DA6A5C'], paper: ['#FCF8F1', '#C06C86'] },
    'dawn-halftone': { graphite: ['#2E3570', '#F09A55'], paper: ['#C9C2E3', '#EFB36A'] },
    'holo-foil': { graphite: ['#8E6CF2', '#5EE7DF'], paper: ['#FF6A9A', '#FFD36B'] },
    'star-chart': { graphite: ['#0B1020', '#E8ECF8'], paper: ['#FAF6EC', '#2B3A55'] },
    'embossed-number': { graphite: ['#16151B', '#3A3842'], paper: ['#F8F3EA', '#D8CBB5'] },
};
