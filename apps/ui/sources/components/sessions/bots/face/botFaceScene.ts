/**
 * Dot styles of a Living Bot face — Dots and Planet — as a Brand `PlanetScene`, painted by the canonical PlanetCanvas.
 *
 * Planet is the app's flat Brand planet (`createPlanetScene`, R6): the Bot only edits the scene, as the Usage meridians
 * do. It drops the lattice dots in the logo notch and in the mouth's channel, recolours the body dots in the Bot's ink
 * inside the scene (never PlanetCanvas `ink`, which would also paint the smile), and appends the flat white smile as
 * round dots over a socket of the planet's deep tone. Dots is the 32 px hex-lattice list form at every size; a hero is
 * that same drawing, enlarged, moving in 2D only (hop, squash, breath, a slight lean).
 */
import {
  createPlanetScene,
  planetLightForProgress,
  type PlanetScene,
  type PlanetSceneDot,
} from '@happier-dev/brand/planet';
import {
  BOT_FACE_COLOURS,
  botFaceGradient,
  type BotFaceTheme,
} from './botFaceArt';
import {
  BOT_FACE_UNIT,
  botFaceGeometry,
  botFaceHash,
  botFaceMoodMouth,
  botFaceMoonGeometry,
  botFaceMouthStrokes,
  botFaceMouthWidth,
  botFaceNormal,
  botFaceSd,
  botFaceStrokeBeads,
  botFaceStrokesDistance,
  type BotFaceMood,
  type BotFaceMutter,
  type BotFacePose,
} from './botFaceGeometry';
import { resolveBotFaceArt, type BotFaceIdentity } from './botFaceIdentity';

export type BotFaceSceneInput = Readonly<{
  style: 'dots' | 'planet';
  identity: BotFaceIdentity;
  size: number;
  dpr: number;
  theme: BotFaceTheme;
  mood: BotFaceMood;
  /** Absent: the still list form. Present: the hero at this pose. */
  hero?: Readonly<{ pose: BotFacePose }>;
  /**
   * Dots in a moment (R8 C) paint the body and the smile as two layers, so the smile can slide against the body as a
   * transform. Absent: both, in one scene.
   */
  layer?: 'body' | 'smile';
  /** The working mouth's mutter step (lab R9). Absent: the still "…". */
  mutter?: BotFaceMutter;
  monochrome?: boolean;
}>;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const SMILE: Readonly<Record<BotFaceTheme, readonly [number, number, number]>> =
  { dark: [250, 247, 242], light: [255, 255, 255] };
const LIT = (() => {
  const l = Math.hypot(-0.62, -0.5, 0.62);
  return [-0.62 / l, -0.5 / l, 0.62 / l];
})();
const grey = (c: readonly number[]): [number, number, number] => {
  const l = c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15;
  return [l, l, l];
};
const dotOf = (
  x: number,
  y: number,
  r: number,
  rgb: readonly number[],
  index: number,
): PlanetSceneDot => ({
  x,
  y,
  r,
  rgb: [rgb[0], rgb[1], rgb[2]],
  opacity: 1,
  i: index,
  j: 0,
});

/** Dots: the hex lattice of big dots, each carrying the body's light; the smile is white beads over a deep socket. */
function dots(input: BotFaceSceneInput): PlanetScene {
  const { identity, size, theme, hero } = input;
  const G = botFaceGeometry(
    identity.body,
    resolveBotFaceArt(identity),
    true,
  );
  const stops = BOT_FACE_COLOURS[identity.colour].stops(theme);
  // A hero is the R6 32 px drawing (9.6 cells) at the hero's framing; lists use the coarser R8 rail lattice, and one
  // key light also sizes their dots (lit dots swell, shaded ones shrink).
  const list = !hero;
  const cells = hero ? 9.6 : size <= 18 ? 5.4 : size <= 24 ? 6.4 : 8.2;
  const listView = Math.max(1.12, G.ext * 1.08);
  const k = size / (2 * listView);
  const p = ((2 * listView) / cells) * 0.86;
  const lim = Math.ceil((G.ext * 1.1) / p) + 1;
  const mouth = botFaceMoodMouth(input.mood, input.mutter);
  const line = botFaceMouthStrokes(G, mouth);
  const cut = Math.max(botFaceMouthWidth(G, 1.6), p * 0.62);
  const raw: [number, number, number, readonly number[]][] = [];
  const bodyOnly = input.layer !== 'smile';
  for (let j = -lim; j <= lim; j++)
    for (let i = -lim; i <= lim; i++) {
      const x = (i + (j & 1 ? 0.5 : 0)) * p,
        y = j * p * 0.866;
      const d = botFaceSd(G, x, y);
      if (!bodyOnly || d > -0.02 || botFaceStrokesDistance(x, y, line) < cut) continue;
      const tt = clamp01(
        ((y - G.top) / (G.bot - G.top)) * 0.9 - x * 0.05 + 0.05,
      );
      const c = botFaceGradient(stops, 0.18 + 0.68 * tt);
      const n = botFaceNormal(G, x, y);
      const day = clamp01(
        (n[0] * LIT[0] + n[1] * LIT[1] + n[2] * LIT[2] + 0.42) / 1.05,
      );
      const sh = list ? 0.42 + 0.74 * day : 0.55 + 0.51 * day;
      raw.push([
        x,
        y,
        p * 0.5 * (0.8 + 0.2 * clamp01(-d / 0.08)) * 0.98 * (list ? 0.8 + 0.3 * day : 1),
        c.map((v) => Math.min(255, v * sh + (list ? 18 : 10) * day)),
      ]);
    }
  const rb = p * 0.5 * (size <= 24 && list ? 0.9 : 0.86) * (list ? 1.12 : 1);
  // "…": the dots stand at least 2.7 bead radii apart, so they never merge into a bar (lab R9).
  const beads = input.layer === 'body' ? [] : botFaceStrokeBeads(line, rb * 1.55, rb * 2.7);
  const socket = botFaceGradient(stops, 0.86).map(
    (v) => v * (theme === 'dark' || list ? 0.5 : 0.62),
  );
  for (const [x, y] of beads) raw.push([x, y, rb * (list ? 1.42 : 1.32), socket]);
  for (const [x, y] of beads) raw.push([x, y, rb, SMILE[theme]]);
  // The hero's 2D motion: hop, squash and breath about the base, a slight lean; no depth turn.
  const pose = hero?.pose;
  const heroView = Math.max(1.3, G.ext * 1.22);
  const kk = hero ? size / (2 * heroView) : k;
  const q = hero ? (listView / heroView) * (1 + (pose?.breath ?? 0)) : 1;
  const sx = q * (pose?.sx ?? 1),
    sy = q * (pose?.sy ?? 1);
  const lean = (pose?.roll ?? 0) * 0.5 + (pose?.yaw ?? 0) * 0.15;
  const cos = Math.cos(lean),
    sin = Math.sin(lean);
  const dy = pose ? (pose.ty - (pose.sy - 1) * G.bot) * kk : 0;
  const body = raw.map(([x, y, r, rgb], index) => {
    const ax = x * k * sx,
      ay = y * k * sy;
    return dotOf(
      size / 2 + ax * cos - ay * sin,
      size / 2 + dy + ax * sin + ay * cos,
      (r * k * (sx + sy)) / 2,
      input.monochrome ? grey(rgb) : rgb,
      index,
    );
  });
  return { body, haze: [], cells: [] };
}

/** Planet: the Brand scene with the Bot's cut, its ink and its smile. */
function planet(input: BotFaceSceneInput): PlanetScene {
  const { identity, size, dpr, theme, hero } = input;
  // R6: Planet always uses the Brand moon, including saved custom/generated faces.
  const G = botFaceMoonGeometry();
  const pose = hero?.pose;
  const mood = pose?.mouth ?? botFaceMoodMouth(input.mood, input.mutter);
  const view = hero
    ? Math.max(1.3, G.ext * 1.22)
    : Math.max(1.12, G.ext * 1.08);
  const k = size / (2 * view); // css px per model unit
  const br = 1 + (pose?.breath ?? 0);
  const sc = (br * ((pose?.sx ?? 1) + (pose?.sy ?? 1))) / 2;
  const oy = (pose?.ty ?? 0) - ((pose?.sy ?? 1) - 1) * G.bot;
  const R0 = (46 / BOT_FACE_UNIT) * sc;
  const cyM = (47 - G.cy) / BOT_FACE_UNIT + oy;
  // Rail sizes take the coarser R8 lattice (5.5 / 6.5 / 8 dots across the moon); heroes keep the Brand pitch.
  const across = hero ? null : size <= 18 ? 5.5 : size <= 24 ? 6.5 : 8;
  const scene = createPlanetScene({
    theme,
    R: R0 * k,
    ...(across ? { pitch: (2 * R0 * k) / across } : {}),
    cx: size / 2,
    cy: size / 2 + cyM * k,
    view: { w: size, h: size },
    dpr,
    rotate:
      (botFaceHash(identity.seed, 3) - 0.5) * 0.9 +
      (hero ? (pose?.yaw ?? 0) * 0.7 : 0),
    mirror: false,
    fullness: hero ? 0.6 : 0.85,
    halo: 0,
    tail: 0,
    style: 'balanced',
    field: { around: 0, over: 0 },
    light: planetLightForProgress(0.84 + 0.16 * botFaceHash(identity.seed, 5)),
    gain: hero ? (pose?.gain ?? 1) : 1,
  });
  const line = botFaceMouthStrokes(G, mood);
  const toModel = (x: number, y: number): [number, number] => [
    (x - size / 2) / k / sc,
    (y - size / 2 - oy * k) / k / sc,
  ];
  const pitch =
    (scene.body.length > 1
      ? Math.abs(scene.body[1].x - scene.body[0].x) || 2 / dpr
      : 2 / dpr) / k;
  const mw = botFaceMouthWidth(G, 1.0) * (hero ? 1 : size <= 24 ? 0.96 : 0.78);
  const clear = mw * 1.35 + pitch * 0.3;
  // Colour picks the form: Daybreak is the Brand palette (Home's planet); any other colour is the Usage moon in its ink.
  const stops = BOT_FACE_COLOURS[identity.colour].stops(theme);
  const inkOn = identity.colour !== 'daybreak';
  const ink = inkOn
    ? botFaceGradient(stops, theme === 'dark' ? 0.42 : 0.72)
    : null;
  const kept = scene.body.filter((dot) => {
    const [x, y] = toModel(dot.x, dot.y);
    return (
      botFaceSd(G, x, y) < -pitch * 0.2 &&
      botFaceStrokesDistance(x, y, line) > clear
    );
  });
  const body: PlanetSceneDot[] = kept.map((dot) => {
    const rgb = ink ?? dot.rgb;
    return ink || input.monochrome
      ? { ...dot, rgb: input.monochrome ? grey(rgb) : [rgb[0], rgb[1], rgb[2]] }
      : dot;
  });
  const deep = inkOn
    ? botFaceGradient(stops, 0.92).map(
        (v) => v * (theme === 'dark' ? 0.5 : 0.62),
      )
    : theme === 'dark'
      ? [20, 34, 98]
      : [64, 70, 168];
  // "…": beads 1.5× the stroke's, at least 2.3 socket radii apart, or they vanish into the Brand lattice (lab R9).
  const dz = mood.dots ? 1.5 : 1;
  const rW = mw * k * sc * dz;
  const rS = rW + dz * Math.max(0.6, (theme === 'dark' ? 0.32 : 0.5) * mw * k * (hero ? 1 : 1.3));
  const beads = botFaceStrokeBeads(line, (rW * 0.55) / (k * sc), (rS * 2.3) / (k * sc));
  let index = body.length;
  for (const [col, r] of [
    [deep, rS],
    [SMILE[theme], rW],
  ] as const) {
    for (const [x, y] of beads)
      body.push(
        dotOf(
          size / 2 + x * k * sc,
          size / 2 + (y * sc + oy) * k,
          r,
          input.monochrome ? grey(col) : col,
          index++,
        ),
      );
  }
  return { body, haze: scene.haze, cells: scene.cells };
}

/** One frame of a dot-style face as a Brand scene, in css px. Pure: the same input always yields the same scene. */
export function createBotFaceScene(input: BotFaceSceneInput): PlanetScene {
  return input.style === 'planet' ? planet(input) : dots(input);
}
