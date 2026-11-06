/**
 * Raster styles of a Living Bot face — Dither, Solid and Pixel — as one RGBA image at device pixels.
 *
 * Port of the R6 lab (`lb2-engine.js` renderer K + `lb3-engine.js` shader4/draw5/drawSprite). The lab ray-marches the
 * slab on the GPU; here each sample inverts the pose onto the slab's front surface (a height field), which is exact for
 * the still list forms' gentle turn and close for the heroes' small turns. Only the done moment's full turn traces the
 * whole slab (front, back and walls). Cells and pixels are whole device pixels, so no seam can show between cells
 * (R6 seams fix).
 */
import {
    BOT_FACE_COLOURS, PIXEL_BODY8, PIXEL_FACE12, PIXEL_FACE8, PIXEL_HEAD12, PIXEL_HEAD8, PIXEL_MUTTER12, PIXEL_MUTTER8,
    PIXEL_SPRITE_OF, PIXEL_SPRITES12, PIXEL_SPRITES8, botFaceGradient, type BotFaceTheme,
} from './botFaceArt';
import {
    BOT_FACE_DEPTH, BOT_FACE_DONE_MS, BOT_FACE_NORMAL_STEP, BOT_FACE_RIM, botFaceGeometry, botFaceMorphAt, botFaceMorphGeometry, botFaceListPose, botFaceMouthStrokes, botFaceMouthWidth, botFaceNormal, botFaceSd,
    botFaceStrokesDistance, botFaceZ, type BotFaceGeometry, type BotFaceMood, type BotFaceMutter, type BotFacePose,
} from './botFaceGeometry';
import { resolveBotFaceArt, type BotFaceIdentity } from './botFaceIdentity';
import { deriveBotFaceSprite } from './botFaceSprite';
import { botFaceMomentTurn, type BotFaceChannels } from './botFaceMotionTokens';

/** `smooth`: the image is shaded below device resolution and the painter scales it with filtering, not pixel snapping. */
/** The head turn the attention brain adds to a list face (R10 A), radians, on top of the moment's own turn. */
export type BotFaceTurn = Readonly<{ yaw: number; pitch: number; roll: number }>;
export type BotFaceRasterImage = Readonly<{ width: number; height: number; data: Uint8ClampedArray<ArrayBuffer>; smooth?: boolean }>;
export type BotFaceRasterInput = Readonly<{
    style: 'dither' | 'solid' | 'pixel';
    identity: BotFaceIdentity;
    /** Logical size of the square, css px. */
    size: number;
    dpr: number;
    theme: BotFaceTheme;
    mood: BotFaceMood;
    /** Absent: the list form (still). Present: the hero, drawn at this pose (and `t` ms into its moment, for Pixel). */
    hero?: Readonly<{ pose: BotFacePose; t: number; rest: boolean }>;
    /**
     * A list face mid-moment (R7, Dither and Solid): the body redrawn at the reaction's channels, its mouth morphing
     * `from` → `to` by `u`, in a stage `pad` css px wider on each side so a hop never clips. At rest channels the stage
     * holds exactly the still face, and `tx` and the lean's foot pivot move the whole cell grid by whole pixels.
     */
    moment?: Readonly<{ channels: BotFaceChannels; from: BotFaceMood; to: BotFaceMood; u: number; pad: number; turn?: BotFaceTurn }>;
    /** The working mouth's mutter step (lab R9): which of its three dots is raised. Absent: the still "…". */
    mutter?: BotFaceMutter;
    /** Pixel's look inside a moment (R8 C): its face rows step one sprite pixel toward the turn. */
    look?: -1 | 0 | 1;
    monochrome?: boolean;
}>;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const norm3 = (x: number, y: number, z: number): [number, number, number] => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
const dot3 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const CAM = 7;
const SMILE: Readonly<Record<BotFaceTheme, readonly [number, number, number]>> = { dark: [250, 247, 242], light: [255, 255, 255] };
/** The 4×4 Bayer matrix the dither thresholds by. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** R = Rz(roll) · Rx(pitch) · Ry(yaw), column-major, y-down world (lab `rotMat`). */
function rotMat(yaw: number, pitch: number, roll: number): number[] {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy], Rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp], Rz = [cr, sr, 0, -sr, cr, 0, 0, 0, 1];
    const mul = (A: number[], B: number[]) => { const C = new Array<number>(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) C[c * 3 + r] = A[r] * B[c * 3] + A[3 + r] * B[c * 3 + 1] + A[6 + r] * B[c * 3 + 2]; return C; };
    return mul(Rz, mul(Rx, Ry));
}
const rotN = (R: number[], n: readonly number[]): [number, number, number] => [R[0] * n[0] + R[3] * n[1] + R[6] * n[2], R[1] * n[0] + R[4] * n[1] + R[7] * n[2], R[2] * n[0] + R[5] * n[1] + R[8] * n[2]];

type Slab = Readonly<{ G: BotFaceGeometry; R: number[]; sc: [number, number, number]; off: [number, number, number]; view: number; mouth: [number, number][][]; turn: boolean }>;
const listView = (G: BotFaceGeometry) => Math.max(1.12, G.ext * 1.08);
function slab(G: BotFaceGeometry, pose: BotFacePose, hero: boolean): Slab {
    const view = hero ? Math.max(1.3, G.ext * 1.22) : listView(G);
    const br = 1 + pose.breath;
    return { G, R: rotMat(pose.yaw + pose.spin, pose.pitch, pose.roll), sc: [pose.sx * br, pose.sy * br, br], off: [0, pose.ty - (pose.sy - 1) * G.bot, 0], view, mouth: botFaceMouthStrokes(G, pose.mouth), turn: pose.spin !== 0 };
}
/** A visible slab point (model units) and, off the front height field, its model normal (back face or wall). */
type Surface = Readonly<{ p: readonly [number, number, number]; n: readonly [number, number, number] | null }>;
/** The front surface point at (X, Y), or, while the done turn shows any side, the nearest point on the whole slab. */
function surfaceAt(S: Slab, X: number, Y: number): Surface | null {
    if (S.turn) return traceSlab(S, X, Y);
    const p = hitAt(S, X, Y);
    return p && botFaceSd(S.G, p[0], p[1]) < 0 ? { p, n: null } : null;
}
/**
 * The done turn: the ray through (X, Y) traced through the slab (the outline extruded between z = ±DEPTH) from the
 * viewer's side. It enters through the front or back face when the outline covers that point there; otherwise it walks
 * the outline's distance field along the ray's footprint until it meets a wall. The rim is not rounded here: the turn
 * lasts under a second.
 */
function traceSlab(S: Slab, X: number, Y: number): Surface | null {
    const { R, sc, off, G } = S; const D = BOT_FACE_DEPTH;
    // Model point m(s) = m0 + s·dm, where s is the world depth (larger is nearer the camera).
    const A = [X - off[0], Y - off[1], -off[2]], B = [-X / CAM, -Y / CAM, 1];
    const tr = (v: number[], i: number) => (R[i * 3] * v[0] + R[i * 3 + 1] * v[1] + R[i * 3 + 2] * v[2]) / sc[i];
    const m0 = [tr(A, 0), tr(A, 1), tr(A, 2)], dm = [tr(B, 0), tr(B, 1), tr(B, 2)];
    const lo = [-G.ext, G.top, -D], hi = [G.ext, G.bot, D]; let near = -Infinity, far = Infinity;
    for (let i = 0; i < 3; i++) {
        if (Math.abs(dm[i]) < 1e-9) { if (m0[i] < lo[i] || m0[i] > hi[i]) return null; continue; }
        const a = (lo[i] - m0[i]) / dm[i], b = (hi[i] - m0[i]) / dm[i];
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    }
    if (!(near <= far)) return null;
    const speed = Math.hypot(dm[0], dm[1]); const eps = 1e-3;
    for (let s = far, i = 0; s >= near && i < 48; i++) {
        const x = m0[0] + s * dm[0], y = m0[1] + s * dm[1], d = botFaceSd(G, x, y);
        if (d <= eps) {
            const z = m0[2] + s * dm[2];
            if (i === 0 && Math.abs(z) > D - 1e-6) {
                // Entered through a face. The back face mirrors the front's rim: same slope, facing away.
                if (z > 0) return { p: [x, y, D], n: null };
                const f = botFaceNormal(G, x, y); return { p: [x, y, -D], n: [f[0], f[1], -f[2]] };
            }
            const e = BOT_FACE_NORMAL_STEP; const gx = botFaceSd(G, x + e, y) - botFaceSd(G, x - e, y), gy = botFaceSd(G, x, y + e) - botFaceSd(G, x, y - e);
            const l = Math.hypot(gx, gy) || 1; return { p: [x, y, Math.max(-D, Math.min(D, z))], n: [gx / l, gy / l, 0] };
        }
        if (speed < 1e-9) return null;
        s -= Math.max(d / speed, eps);
    }
    return null;
}
/** The model point on the slab's front surface seen at screen point (X, Y) (model-view units), or null when it misses. */
function hitAt(S: Slab, X: number, Y: number): [number, number, number] | null {
    const { R, sc, off, G } = S;
    // Most rays land on the flat front face: intersect its plane exactly and keep the hit when the face is flat there.
    {
        const D = BOT_FACE_DEPTH * sc[2], u = X / CAM, v = Y / CAM, wz0 = R[8] * D + off[2];
        const a11 = (R[0] + u * R[2]) * sc[0], a12 = (R[3] + u * R[5]) * sc[1], a21 = (R[1] + v * R[2]) * sc[0], a22 = (R[4] + v * R[5]) * sc[1];
        const b1 = X - (R[6] * D + off[0]) - u * wz0, b2 = Y - (R[7] * D + off[1]) - v * wz0; const det = a11 * a22 - a12 * a21;
        const x = (b1 * a22 - a12 * b2) / det, y = (a11 * b2 - a21 * b1) / det;
        if (botFaceZ(G, x, y) === BOT_FACE_DEPTH) return [x, y, BOT_FACE_DEPTH];
    }
    const a = R[0] * sc[0], b = R[1] * sc[0], c = R[3] * sc[1], d = R[4] * sc[1]; const det = a * d - b * c;
    let z = botFaceDepthOrFlat(G, 0, 0), wz = R[8] * sc[2] * z + off[2]; let x = 0, y = 0;
    for (let i = 0; i < 3; i++) {
        const k = (CAM - wz) / CAM; const tx = X * k - (R[6] * sc[2] * z + off[0]), ty = Y * k - (R[7] * sc[2] * z + off[1]);
        x = (d * tx - c * ty) / det; y = (-b * tx + a * ty) / det;
        z = botFaceZ(G, x, y);
        wz = R[2] * sc[0] * x + R[5] * sc[1] * y + R[8] * sc[2] * z + off[2];
    }
    return [x, y, z];
}
const botFaceDepthOrFlat = (G: BotFaceGeometry, x: number, y: number) => Math.max(0, botFaceZ(G, x, y));
const albedoAt = (stops: ReturnType<typeof BOT_FACE_COLOURS.indigo.stops>, G: BotFaceGeometry, x: number, y: number, lo: number, hi: number) => {
    const s = clamp01((y - G.top) / (G.bot - G.top)); const c = botFaceGradient(stops, lo + (hi - lo) * clamp01(s * 0.9 - x * 0.06 + 0.05));
    return [c[0] / 255, c[1] / 255, c[2] / 255] as const;
};

const L1 = norm3(-0.55, -0.78, 0.62), L2 = norm3(0.85, -0.05, 0.45), L3 = norm3(0.25, -0.55, -0.8);
function studio(r: readonly number[]): [number, number, number] {
    const t = smoothstep(-0.35, 0.75, -r[1]); const c: [number, number, number] = [0.16 + 0.82 * t, 0.15 + 0.82 * t, 0.17 + 0.78 * t];
    const key = 1.25 * Math.exp(-((Math.hypot(r[0] + 0.5, r[1] + 0.62) * 2.6) ** 2)) * (r[2] >= 0 ? 1 : 0);
    const fill = Math.exp(-((Math.hypot(r[0] - 0.75, r[1] + 0.1) * 3.2) ** 2));
    return [c[0] + key + 0.45 * fill, c[1] + key + 0.5 * fill, c[2] + key + 0.6 * fill];
}
/** Ceramic (the Dither's material): diffuse + fill + back rim, a soft environment reflection and one highlight. */
function ceramic(alb: readonly number[], n: readonly number[]): [number, number, number] {
    const dif = clamp01((dot3(n, L1) + 0.35) / 1.35), fil = clamp01(dot3(n, L2)), rim = clamp01(dot3(n, L3)) ** 2;
    const fr = 0.04 + 0.96 * (1 - clamp01(n[2])) ** 5; const h1 = norm3(L1[0], L1[1], L1[2] + 1); const nh = clamp01(dot3(n, h1));
    const refl = studio([2 * n[2] * n[0], 2 * n[2] * n[1], 2 * n[2] * n[2] - 1]); const sky = 0.5 - 0.5 * n[1];
    const amb = [0.42 + 0.58 * sky, 0.4 + 0.6 * sky, 0.44 + 0.56 * sky]; const spec = nh ** 60 * 0.32;
    return [0, 1, 2].map(i => alb[i] * (0.28 * amb[i] + 0.78 * dif + 0.16 * fil) + alb[i] * rim * 0.35 + refl[i] * fr * 0.38 + spec) as [number, number, number];
}
const K1 = norm3(-0.5, -0.78, 0.62), K2 = norm3(0.85, 0.15, 0.5), K3 = norm3(0.55, -0.55, -0.62);
const aces = (x: number) => Math.pow(clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)), 1 / 2.2);
/** Matte (Solid): key/fill/sky/back-rim weights and the ACES curve, no specular. `contrast` steepens the key (lists). */
function matte(alb: readonly number[], n: readonly number[], contrast = 1): [number, number, number] {
    const key = Math.max(0, (dot3(n, K1) + 0.12) / 1.12) ** contrast, fl = Math.max(0, dot3(n, K2)), skyT = 0.5 - 0.5 * n[1], nv = Math.max(0, n[2]);
    const rk = Math.max(0, dot3(n, K3)); const rimT = 0.9 * rk * rk * (1 - nv) ** 1.6; const x = 0.05 + 0.1 * skyT + 1.25 * key + 0.16 * fl; const tint = [0.62, 0.78, 1];
    return [0, 1, 2].map(i => { const al = alb[i] ** 2.2; return aces((al * x + rimT * tint[i] * (0.35 + al) * 0.42) * 1.08); }) as [number, number, number];
}

function image(size: number, dpr: number, pad = 0): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
    const px = Math.max(1, Math.round(size * dpr)) + 2 * Math.round(pad * dpr); return { width: px, height: px, data: new Uint8ClampedArray(px * px * 4) };
}
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/**
 * The list pose a moment draws (lab R7 `drawRail7`): the resting list pose and mouth blended `from` → `to`, then the
 * channels laid on: lift (`ty`, a fraction of the face), stretch about the foot, lean in degrees.
 */
function momentPose(G: BotFaceGeometry, m: NonNullable<BotFaceRasterInput['moment']>, mutter?: BotFaceMutter): BotFacePose {
    const a = botFaceListPose(m.from, mutter), b = botFaceListPose(m.to, mutter), u = m.u, c = m.channels; const turn = botFaceMomentTurn(c);
    // A dotted mouth does not morph: the hop's mouth lands on "…" from whichever mouth is nearer (lab R9).
    const near = (u < 0.5 ? a : b).mouth;
    const mouth = { w: lerp(a.mouth.w, b.mouth.w, u), d: lerp(a.mouth.d, b.mouth.d, u), o: lerp(a.mouth.o, b.mouth.o, u), y: lerp(a.mouth.y, b.mouth.y, u),
        ...(near.dots ? { w: near.w, d: near.d, dots: near.dots, lift: near.lift } : {}) };
    const look = m.turn ?? { yaw: 0, pitch: 0, roll: 0 };
    return { ...a, yaw: lerp(a.yaw, b.yaw, u) + turn.yaw + look.yaw, pitch: lerp(a.pitch, b.pitch, u) + turn.pitch + look.pitch, mouth,
        ty: c.ty * 2 * listView(G), sx: c.sx, sy: c.sy, roll: (c.rot * Math.PI) / 180 + look.roll };
}
/** Where the face box starts inside the image (image px), and the whole-pixel shift a moment's `tx` and lean add. */
function frameOrigin(input: BotFaceRasterInput, G: BotFaceGeometry, scale: number, k: number): { pad: number; shift: number } {
    const m = input.moment; if (!m) return { pad: 0, shift: 0 };
    const pivot = Math.sin((m.channels.rot * Math.PI) / 180) * G.bot * k; // lean about the foot, not the centre
    return { pad: Math.round(m.pad * scale), shift: Math.round(m.channels.tx * input.size * scale + pivot) };
}
function put(img: { width: number; data: Uint8ClampedArray }, x: number, y: number, r: number, g: number, b: number, a: number) {
    const i = (y * img.width + x) * 4; img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
}

/** A hero's body at this moment: blended toward its limb pose while working or needing you (lists stay still). */
function heroGeometry(input: BotFaceRasterInput, G: BotFaceGeometry, hinted: boolean): BotFaceGeometry {
    const morph = input.hero && !input.identity.shape ? botFaceMorphAt(input.identity.body, input.mood, input.hero.t, input.hero.rest) : null;
    return morph ? botFaceMorphGeometry(G, input.identity.body, morph, hinted) : G;
}

function ditherPitch(size: number, dpr: number, hero: boolean): number {
    return hero ? Math.max(1, Math.round(Math.max(2, Math.round(size / 34) * dpr * 0.75)))
        : Math.max(2, Math.round((size * dpr) / (size <= 18 ? 9 : size <= 24 ? 10.5 : 12)));
}
/** Dither: the fine-cell colour pixel dither, three tones of the body's own colour by the Bayer matrix. */
/** Dither's hero: the fine-cell colour pixel dither, three tones of the body's own colour by the Bayer matrix. */
function dither(input: BotFaceRasterInput): BotFaceRasterImage {
    const { identity, size, dpr, theme, hero } = input;
    if (!hero) return ditherList(input);
    const G = heroGeometry(input, botFaceGeometry(identity.body, resolveBotFaceArt(identity), false), false);
    const S = slab(G, hero.pose, true);
    const img = image(size, dpr); const k = Math.max(1, Math.round(size * dpr)) / (2 * S.view);
    const pitch = ditherPitch(size, dpr, true);
    const mw = botFaceMouthWidth(G, 1.35); const stops = BOT_FACE_COLOURS[identity.colour].stops(theme); const gain = hero.pose.gain;
    const cells = Math.ceil((img.width + pitch) / pitch);
    const inner = Math.max(1, Math.round(size * dpr)) / 2;
    for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
        const X = ((cx + 0.5) * pitch - inner) / k, Y = ((cy + 0.5) * pitch - inner) / k;
        const hit = surfaceAt(S, X, Y); if (!hit) continue; const { p } = hit;
        const alb = albedoAt(stops, G, p[0], p[1], 0.22, 0.72); const n = rotN(S.R, hit.n ?? botFaceNormal(G, p[0], p[1]));
        const col = ceramic(alb, n).map(v => v * gain);
        let lum = clamp01(dot3(col, [0.3, 0.55, 0.15]));
        if (p[2] > 0 && botFaceStrokesDistance(p[0], p[1], S.mouth) < mw) lum *= 0.25; // the carved groove, on the front only
        const by = (BAYER[(cy % 4) * 4 + (cx % 4)] + 0.5) / 16; const tone = clamp01(Math.floor(clamp01(lum * 1.15) * 2 + by) / 2);
        const c = lum < 0.04 ? alb.map(v => v * 0.58 * 0.78) : tone < 0.25 ? alb.map(v => v * 0.58) : tone < 0.75 ? alb.map(v => v * 0.98) : alb.map(v => v + (1 - v) * 0.4);
        const x1 = Math.min(img.width, (cx + 1) * pitch), y1 = Math.min(img.height, (cy + 1) * pitch);
        for (let y = cy * pitch; y < y1; y++) for (let x = cx * pitch; x < x1; x++) put(img, x, y, c[0] * 255, c[1] * 255, c[2] * 255, 255);
    }
    return img;
}

type DitherCell = { alb: readonly [number, number, number]; n: readonly number[]; lum: number; mouth: boolean };
/**
 * Dither's list form (R8 direction C at rest: hinted and lit). Each cell is kept by its covered area (3×3 samples, at
 * least half), not its centre; three tones are dithered only in a narrow band between two (a 2×2 checker, no speckle);
 * the mouth owns the whole cells its centre line crosses; and one key light from the top left bevels the silhouette in
 * whole cells: lit top and left edges, shaded right edge, the deepest tone on the ground line, a lit lower lip.
 */
function ditherList(input: BotFaceRasterInput): BotFaceRasterImage {
    const { identity, size, dpr, theme } = input; const body = resolveBotFaceArt(identity);
    const G = botFaceGeometry(identity.body, body, true);
    const pose = input.moment ? momentPose(G, input.moment, input.mutter) : botFaceListPose(input.mood, input.mutter); const S = slab(G, pose, false);
    const img = image(size, dpr, input.moment?.pad); const box = Math.max(1, Math.round(size * dpr)); const k = box / (2 * S.view);
    const pitch = ditherPitch(size, dpr, false);
    const { pad, shift } = frameOrigin(input, G, dpr, k); const ox = pad + shift, oy = pad, inner = box / 2;
    const c0 = -Math.ceil(ox / pitch), c1 = Math.ceil((img.width - ox) / pitch), r0 = -Math.ceil(oy / pitch), r1 = Math.ceil((img.height - oy) / pitch);
    const nC = c1 - c0, nR = r1 - r0; const cells: (DitherCell | null)[] = new Array(nC * nR).fill(null);
    const stops = BOT_FACE_COLOURS[identity.colour].stops(theme);
    for (let cy = r0; cy < r1; cy++) for (let cx = c0; cx < c1; cx++) {
        let hits = 0, best: readonly number[] | null = null, bd = Infinity;
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
            const X = ((cx + (sx + 0.5) / 3) * pitch - inner) / k, Y = ((cy + (sy + 0.5) / 3) * pitch - inner) / k;
            const hit = surfaceAt(S, X, Y); if (!hit) continue; hits++;
            const dd = (sx - 1) ** 2 + (sy - 1) ** 2; if (dd < bd) { bd = dd; best = hit.p; }
        }
        if (!best || hits < 5) continue;
        const alb = albedoAt(stops, G, best[0], best[1], 0.26, 0.7); const n = rotN(S.R, botFaceNormal(G, best[0], best[1]));
        cells[(cy - r0) * nC + (cx - c0)] = { alb, n, lum: clamp01(dot3(ceramic(alb, n), [0.3, 0.55, 0.15])), mouth: false };
    }
    const at = (cx: number, cy: number) => (cx < c0 || cy < r0 || cx >= c1 || cy >= r1 ? null : cells[(cy - r0) * nC + (cx - c0)]);
    // The mouth as a glyph: the cells its centre line crosses, projected through the pose (front only).
    const project = (x: number, y: number): [number, number] => {
        const m = [x * S.sc[0], y * S.sc[1], BOT_FACE_DEPTH * S.sc[2]]; const R = S.R;
        const wx = R[0] * m[0] + R[3] * m[1] + R[6] * m[2] + S.off[0], wy = R[1] * m[0] + R[4] * m[1] + R[7] * m[2] + S.off[1], wz = R[2] * m[0] + R[5] * m[1] + R[8] * m[2] + S.off[2];
        const f = CAM / (CAM - wz); return [inner + wx * f * k, inner + wy * f * k];
    };
    if (pose.mouth.dots) {
        // "…" hinted (lab R9): single cells one empty cell apart, centred on the mouth, on its unlifted row; the row
        // moves up a cell when a dot would have no body under it, and a raised dot sits one cell higher.
        const rest = botFaceMouthStrokes(G, { ...pose.mouth, lift: undefined });
        const mid = rest[(rest.length - 1) >> 1][0]; const [MX, MY] = project(mid[0], mid[1]);
        const ccx = Math.floor(MX / pitch), ccy = Math.floor(MY / pitch); const offsets = rest.map((_, i) => 2 * (i - ((rest.length - 1) >> 1)));
        const row = offsets.some(d => !at(ccx + d, ccy + 1)) ? ccy - 1 : ccy;
        offsets.forEach((d, i) => { const c = at(ccx + d, row - (pose.mouth.lift?.[i] ? 1 : 0)); if (c && c.n[2] > 0.15) c.mouth = true; });
    } else for (const line of S.mouth) for (let i = 1; i < line.length; i++) for (let t = 0; t <= 1; t += 0.05) {
        const [X, Y] = project(lerp(line[i - 1][0], line[i][0], t), lerp(line[i - 1][1], line[i][1], t));
        const c = at(Math.floor(X / pitch), Math.floor(Y / pitch)); if (c && c.n[2] > 0.15) c.mouth = true;
    }
    const inkPaper = identity.colour === 'ink' && theme === 'light';
    for (let cy = r0; cy < r1; cy++) for (let cx = c0; cx < c1; cx++) {
        const c = at(cx, cy); if (!c) continue;
        const q = clamp01(c.lum * 1.15) * 2, f = q - Math.floor(q);
        let tone = Math.min(2, Math.floor(q) + (f > 0.62 ? 1 : f > 0.38 ? (cx + cy) & 1 : 0));
        const up = at(cx, cy - 1);
        if (!at(cx, cy + 1)) tone = -1; else if (!at(cx + 1, cy)) tone = Math.min(tone, 0); else if (!up || !at(cx - 1, cy)) tone = 2; else tone = Math.max(1, tone);
        if (!c.mouth && up?.mouth) tone = 2;
        const a = c.alb; const rgb = c.mouth ? (inkPaper ? [1, 1, 1] : a.map(v => v * 0.24))
            : tone < 0 ? a.map(v => v * 0.44) : tone === 0 ? a.map(v => v * 0.58) : tone === 1 ? a.map(v => v * 0.98) : a.map(v => v + (1 - v) * 0.4);
        const x1 = Math.min(img.width, ox + (cx + 1) * pitch), y1 = Math.min(img.height, oy + (cy + 1) * pitch);
        for (let y = Math.max(0, oy + cy * pitch); y < y1; y++) for (let x = Math.max(0, ox + cx * pitch); x < x1; x++) put(img, x, y, rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, 255);
    }
    return img;
}

/** Solid: the matte slab with the flat printed smile; a hero stands on a soft contact shadow. */
function solid(input: BotFaceRasterInput): BotFaceRasterImage {
    const { identity, size, dpr, theme, hero } = input; const body = resolveBotFaceArt(identity);
    const G = heroGeometry(input, botFaceGeometry(identity.body, body, true), true);
    const pose = hero?.pose ?? (input.moment ? momentPose(G, input.moment, input.mutter) : botFaceListPose(input.mood, input.mutter)); const S = slab(G, pose, !!hero);
    // Matte shading is smooth, so a hero shades one sample per point and the painter filters the upscale: per-pixel
    // shading at 2–3× device pixels cost ~4–9× more per frame for no visible gain (lane LB-UI measurement).
    const scale = hero ? Math.min(dpr, 1) : dpr;
    const img: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer>; smooth?: boolean } = image(size, scale, hero ? 0 : input.moment?.pad);
    if (hero && dpr > 1) img.smooth = true;
    const k = Math.max(1, Math.round(size * scale)) / (2 * S.view); const aa = 1 / k;
    const { pad, shift } = frameOrigin(input, G, scale, k); const cx0 = pad + shift + Math.max(1, Math.round(size * scale)) / 2, cy0 = pad + Math.max(1, Math.round(size * scale)) / 2;
    // A list face is hinted (R8 A/B): a mouth of at least 1.5 css px, half the anti-alias ramp, a steeper key light with
    // a soft highlight, and a contact shade under the foot that stays on the floor while the body lifts.
    const list = !hero;
    // A dot reads as a dot only a little rounder than the stroke (lab R9: 1.6 × the stroke's half-width).
    const mw = (list ? Math.max(botFaceMouthWidth(G, 1.5), 0.75 / (size / (2 * S.view))) : botFaceMouthWidth(G, 1.25)) * (pose.mouth.dots ? 1.6 : 1);
    const stops = BOT_FACE_COLOURS[identity.colour].stops(theme); const smile = SMILE[theme].map(v => v / 255);
    const shadow = hero ? (theme === 'dark' ? 0.5 : 0.22) * (1 + pose.ty * 2.5) : theme === 'dark' ? 0.42 : 0.2;
    const floor = G.bot + (hero ? 0.07 : 0.04), spread = hero ? 0.78 : 0.7, depth = hero ? 0.11 : 0.07;
    // Only pixels the posed slab or its shadow can reach are shaded: the slab's projected box, and the shadow's band.
    const box = projectedBox(S, aa); const shadowBox = { x0: S.off[0] - 3 * spread * S.sc[0], x1: S.off[0] + 3 * spread * S.sc[0], y0: floor - 3 * depth, y1: floor + 3 * depth };
    const highlight = norm3(K1[0], K1[1], K1[2] + 1);
    const front = [S.R[6], S.R[7], S.R[8]] as const; const mouth = mouthBox(S.mouth, mw * 1.05);
    for (let py = 0; py < img.height; py++) {
        const Y = (py + 0.5 - cy0) / k;
        const rowBody = Y >= box.y0 && Y <= box.y1, rowShadow = Y >= shadowBox.y0 && Y <= shadowBox.y1;
        if (!rowBody && !rowShadow) continue;
        for (let px = 0; px < img.width; px++) {
            const X = (px + 0.5 - cx0) / k;
            const inBody = rowBody && X >= box.x0 && X <= box.x1, inShadow = rowShadow && X >= shadowBox.x0 && X <= shadowBox.x1;
            if (!inBody && !inShadow) continue;
            const sh = inShadow ? shadow * Math.exp(-(((X - S.off[0]) / (spread * S.sc[0])) ** 2) - ((Y - floor) / depth) ** 2) : 0;
            const traced = inBody && S.turn ? traceSlab(S, X, Y) : null;
            const p = traced ? traced.p : inBody && !S.turn ? hitAt(S, X, Y) : null;
            const sd = p ? botFaceSd(G, p[0], p[1]) : Infinity; const ramp = clamp01(0.5 - sd / aa);
            const cov = traced?.n?.[2] === 0 ? 1 : list ? smoothstep(0.15, 0.85, ramp) : ramp; // a wall is opaque
            if (cov <= 0 && sh <= 0.002) continue;
            let r = 0, g = 0, b = 0;
            if (cov > 0 && p) {
                // Deep inside the outline the face is flat, so its normal is the slab's front (no field samples needed).
                const n = traced?.n ? rotN(S.R, traced.n) : sd < -BOT_FACE_RIM - 2 * BOT_FACE_NORMAL_STEP ? front : rotN(S.R, botFaceNormal(G, p[0], p[1]));
                const c = matte(albedoAt(stops, G, p[0], p[1], 0.34, 0.62), n, list ? 1.6 : 1); const spec = list ? clamp01(dot3(n, highlight)) ** 24 * 0.38 : 0;
                r = (c[0] + spec) * pose.gain; g = (c[1] + spec) * pose.gain; b = (c[2] + spec) * pose.gain;
                if (p[2] > 0 && n[2] > 0.15 && p[0] >= mouth.x0 && p[0] <= mouth.x1 && p[1] >= mouth.y0 && p[1] <= mouth.y1) {
                    const m = smoothstep(mw * 1.05, mw * (list ? 0.9 : 0.8), botFaceStrokesDistance(p[0], p[1], S.mouth));
                    r += (smile[0] - r) * m; g += (smile[1] - g) * m; b += (smile[2] - b) * m;
                }
            }
            const sa = sh * (1 - cov); const a = cov + sa; if (a <= 0) continue;
            put(img, px, py, (clamp01(r) * cov / a) * 255, (clamp01(g) * cov / a) * 255, (clamp01(b) * cov / a) * 255, a * 255);
        }
    }
    return img;
}
/** The model-space box beyond which a point is farther than `reach` from the mouth line (the smile cannot touch it). */
function mouthBox(strokes: readonly (readonly (readonly [number, number])[])[], reach: number): { x0: number; x1: number; y0: number; y1: number } {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const line of strokes) for (const [x, y] of line) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0: x0 - reach, x1: x1 + reach, y0: y0 - reach, y1: y1 + reach };
}
/** The screen-space box (model-view units) the posed slab can cover: its model box's eight corners, projected. */
function projectedBox(S: Slab, pad: number): { x0: number; x1: number; y0: number; y1: number } {
    const { R, sc, off, G } = S; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const mx of [-G.ext, G.ext]) for (const my of [G.top, G.bot]) for (const mz of [S.turn ? -BOT_FACE_DEPTH : 0, BOT_FACE_DEPTH]) {
        const x = mx * sc[0], y = my * sc[1], z = mz * sc[2];
        const wx = R[0] * x + R[3] * y + R[6] * z + off[0], wy = R[1] * x + R[4] * y + R[7] * z + off[1], wz = R[2] * x + R[5] * y + R[8] * z + off[2];
        const f = CAM / (CAM - wz); x0 = Math.min(x0, wx * f); x1 = Math.max(x1, wx * f); y0 = Math.min(y0, wy * f); y1 = Math.max(y1, wy * f);
    }
    const m = 2 * pad; return { x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m };
}

/* ═══ Pixel: locked sprites on a whole-pixel grid ═══ */
type Grid = string[];
const spriteKey = (k: string, set: Readonly<Record<string, unknown>>) => (set[k] ? k : set[PIXEL_SPRITE_OF[k] ?? ''] ? PIXEL_SPRITE_OF[k] : 'bag');
function overlay(rows: Grid, r: number, s: string) {
    if (!rows[r]) return; const a = rows[r].split('');
    for (let i = 0; i < s.length; i++) { if (s[i] === 'X' || s[i] === 'F') a[i] = s[i]; else if (s[i] === 'o') a[i] = '.'; }
    rows[r] = a.join('');
}
const face12 = (mood: BotFaceMood, mutter?: BotFaceMutter) => (mood === 'working' && mutter != null ? PIXEL_MUTTER12[mutter] : PIXEL_FACE12[mood]);
const face8 = (mood: BotFaceMood, mutter?: BotFaceMutter) => (mood === 'working' && mutter != null ? PIXEL_MUTTER8[mutter] : PIXEL_FACE8[mood]);
function grid12(shape: string, mood: BotFaceMood, frame: number, mutter?: BotFaceMutter): Grid {
    const sp = PIXEL_SPRITES12[spriteKey(shape, PIXEL_SPRITES12)]; const W = sp.W, ox = sp.ox ?? 0;
    const n = Math.max(sp.below.length, (sp.over ?? [0]).length, (sp.above ?? [0]).length); const f = frame % n;
    const pad = (r: string) => '.'.repeat(ox) + r + '.'.repeat(Math.max(0, W - ox - r.length));
    const body = sp.alt && f % 2 ? sp.alt : sp.body;
    const rows = [...PIXEL_HEAD12, ...face12(mood, mutter), ...body].map(pad);
    if (sp.over) { const ov = sp.over[f % sp.over.length]; for (const r in ov) overlay(rows, Number(r), ov[r]); }
    return [...(sp.above ? sp.above[f % sp.above.length] : []), ...rows, ...(sp.below[f % sp.below.length] ?? [])];
}
function grid8(shape: string, mood: BotFaceMood, mutter?: BotFaceMutter): Grid {
    const sp = PIXEL_SPRITES8[spriteKey(shape, PIXEL_SPRITES8)]; const W = sp.W, ox = sp.ox ?? 0;
    const pad = (r: string) => '.'.repeat(ox) + r + '.'.repeat(Math.max(0, W - ox - r.length));
    const rows = [...PIXEL_HEAD8, ...face8(mood, mutter), ...PIXEL_BODY8].map(pad);
    if (sp.over) for (const r in sp.over) overlay(rows, Number(r), sp.over[r]);
    return [...(sp.above ?? []), ...rows, ...(sp.below ?? [])];
}
export function botFacePixelFrames(shape: string): number {
    const sp = PIXEL_SPRITES12[spriteKey(shape, PIXEL_SPRITES12)];
    return Math.max(sp.below.length, (sp.over ?? [0]).length, (sp.above ?? [0]).length, sp.alt ? 2 : 1);
}
/** The sprite, its drawn pixel (device px) and its face rows (the mouth) for this face and moment. */
function pixelLayout(input: BotFaceRasterInput, img: { width: number; height: number }): { g: Grid; px: number; face: number; faceRows: number } {
    const { identity, size, dpr, hero } = input; const t = hero?.t ?? 0;
    const mood: BotFaceMood = input.mood === 'done' && (!hero || hero.rest || t > BOT_FACE_DONE_MS) && hero ? 'quiet' : input.mood;
    const micro = size <= 24 && !hero; let g: Grid; let px: number;
    if (identity.shape) {
        const sprite = deriveBotFaceSprite(identity.shape, mood, micro ? 8 : 12, input.mutter);
        g = sprite.grid;
        const cols = Math.max(...g.map(row => row.length));
        px = hero ? Math.max(1, Math.floor(Math.min(img.width / cols, img.height / Math.max(g.length, 12)) * 0.8))
            : Math.max(1, Math.floor(size * dpr * (micro ? 0.94 : 0.8) / Math.max(micro ? 8 : 12, cols * 0.86, g.length * 0.8)));
        return { g, px, face: sprite.mouthRow, faceRows: sprite.mouthRows };
    }
    if (micro) {
        g = grid8(identity.body, mood, input.mutter); const cols = Math.max(...g.map(r => r.length));
        // R8 A: the micro sprite fills 94% of the rail box (R6: 80%).
        px = Math.max(1, Math.floor((size * dpr * 0.94) / Math.max(8, cols * 0.86, g.length * 0.8)));
        return { g, px, face: (PIXEL_SPRITES8[spriteKey(identity.body, PIXEL_SPRITES8)].above?.length ?? 0) + PIXEL_HEAD8.length, faceRows: 2 };
    }
    {
        const per = input.mood === 'working' ? 240 : 560; const frame = hero && !hero.rest ? Math.floor(t / per) % botFacePixelFrames(identity.body) : 0;
        g = grid12(identity.body, mood, frame, input.mutter); const cols = Math.max(...g.map(r => r.length));
        px = hero ? Math.max(1, Math.floor(Math.min(img.width / cols, img.height / Math.max(g.length, 12)) * 0.8))
            : Math.max(1, Math.floor((size * dpr * 0.8) / Math.max(12, cols * 0.86, g.length * 0.8)));
    }
    const sp = PIXEL_SPRITES12[spriteKey(identity.body, PIXEL_SPRITES12)];
    return { g, px, face: (sp.above?.[0]?.length ?? 0) + PIXEL_HEAD12.length, faceRows: 3 };
}
function pixel(input: BotFaceRasterInput): BotFaceRasterImage {
    const { identity, theme, hero } = input; const img = image(input.size, input.dpr); const t = hero?.t ?? 0;
    const { g, px, face, faceRows } = pixelLayout(input, img);
    const cols = Math.max(...g.map(r => r.length)), rows = g.length; const live = hero && !hero.rest;
    const lit = !hero, look = hero ? 0 : input.look ?? 0;
    const hop = live && input.mood === 'needsYou' && t < 500 ? (t < 140 ? 0 : t < 360 ? 1 : 0) : 0;
    const dh = live && input.mood === 'done' ? (t > 140 && t < 520 ? 2 : t > 520 && t < 700 ? 1 : 0) : 0;
    const ox = Math.floor((img.width - cols * px) / 2), oy = Math.floor((img.height - rows * px) / 2) - (hop + dh) * px;
    const stops = BOT_FACE_COLOURS[identity.colour].stops(theme);
    const base = botFaceGradient(stops, 0.5), hi = botFaceGradient(stops, 0.18), lo = botFaceGradient(stops, 0.86); const flash = hi.map(v => v + (255 - v) * 0.5);
    const deep = lo.map(v => v * 0.72), spec = hi.map(v => v + (255 - v) * 0.45);
    const at = (x: number, y: number) => (g[y]?.[x] && g[y][x] !== '.' ? g[y][x] : null);
    const fillCell = (gx: number, gy: number, c: readonly number[], a = 255) => {
        for (let y = Math.max(0, oy + gy * px); y < Math.min(img.height, oy + (gy + 1) * px); y++)
            for (let x = Math.max(0, ox + gx * px); x < Math.min(img.width, ox + (gx + 1) * px); x++) put(img, x, y, c[0], c[1], c[2], a);
    };
    // A look moves only the face rows: their holes are filled with the body, then cut again one sprite pixel over.
    const inFace = (y: number) => look !== 0 && y >= face && y < face + faceRows;
    const between = (x: number, y: number) => g[y].slice(0, x).replace(/\./g, '') !== '' && g[y].slice(x + 1).replace(/\./g, '') !== '';
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const c = at(x, y) ?? (inFace(y) && between(x, y) ? 'X' : null); if (!c) continue;
        let col = c === 'F' ? flash : !at(x, y - 1) && x < cols * 0.7 ? hi : !at(x + 1, y) || !at(x, y + 1) ? lo : base;
        // R8 B: one key light, top left: a deep ground row, a highlight on the top-left corner, a lit left edge.
        if (lit) { if (!at(x, y + 1) && !inFace(y)) col = deep; else if (!at(x - 1, y) && !at(x, y - 1)) col = spec; else if (!at(x - 1, y) && col === base) col = hi; }
        fillCell(x, y, col);
    }
    if (look) for (let y = face; y < face + faceRows; y++) for (let x = 1; x < cols - 1; x++) {
        if (at(x, y) || !between(x, y)) continue; const tx = x + look;
        if (at(tx, y) || between(tx, y)) fillCell(tx, y, [0, 0, 0], 0);
    }
    if (live && input.mood === 'done' && t < BOT_FACE_DONE_MS) {
        const k = Math.floor(t / 180) % 3; const spark = botFaceGradient(stops, 0.15);
        ([[-2, 1], [cols + 1, 3], [-1, 8], [cols, 10], [cols + 2, 0]] as const).forEach(([sx, sy], i) => { if ((i + k) % 2 === 0) fillCell(sx, sy, spark); });
    }
    return img;
}

/** Greyscale for a face whose Session is not live (the generic avatars' `monochrome`). */
function monochrome(img: BotFaceRasterImage): BotFaceRasterImage {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] * 0.3 + d[i + 1] * 0.55 + d[i + 2] * 0.15; d[i] = d[i + 1] = d[i + 2] = l; }
    return img;
}

/**
 * The face's own grid step in css px: Dither's cell, Pixel's drawn sprite pixel, one device pixel for Solid. Motion
 * that steps (Pixel's moves, Dither's breath) steps in this, so it never falls off the drawing's grid.
 */
export function botFaceRasterStep(input: BotFaceRasterInput): number {
    const device = input.style === 'dither' ? ditherPitch(input.size, input.dpr, !!input.hero)
        : input.style === 'pixel' ? pixelLayout(input, image(input.size, input.dpr)).px : 1;
    return device / input.dpr;
}

/** One frame of a raster-style face. Pure: the same input always draws the same pixels. */
export function drawBotFaceRaster(input: BotFaceRasterInput): BotFaceRasterImage {
    const img = input.style === 'dither' ? dither(input) : input.style === 'solid' ? solid(input) : pixel(input);
    return input.monochrome ? monochrome(img) : img;
}
