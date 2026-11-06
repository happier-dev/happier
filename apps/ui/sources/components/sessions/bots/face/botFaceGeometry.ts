/** Rendering-only hinting, morphs and poses; portable outline math is shared with Action admission. */
import { BOT_FACE_BODIES, BOT_FACE_MOON, BOT_FACE_MORPH_ART, BOT_FACE_MORPHS, hintBody, type BotFaceBodyArt, type BotFaceBodyId, type BotFaceMorphId } from './botFaceArt';
import type { BotFaceMouth as Mouth } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import { botFaceMotionTokens } from './botFaceMotionTokens';
import { BOT_FACE_UNIT, BOT_FACE_FIELD_EXTENT, BOT_FACE_RIM, BOT_FACE_WALL, BOT_FACE_DEPTH, BOT_FACE_NORMAL_STEP, BOT_FACE_MOUTHS, botFaceSd, botFaceZ, botFaceNormal, botFaceMouthPoints, botFaceMouthLine, botFaceSegDistance, botFaceMouthWidth, botFaceBeads, botFaceMouthStrokes, botFaceStrokesDistance, botFaceStrokeBeads, createBotFaceGeometry, botFaceArtHash, type BotFaceGeometry, type BotFaceMood } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
export { BOT_FACE_UNIT, BOT_FACE_FIELD_EXTENT, BOT_FACE_RIM, BOT_FACE_WALL, BOT_FACE_DEPTH, BOT_FACE_NORMAL_STEP, BOT_FACE_MOUTHS, botFaceSd, botFaceZ, botFaceNormal, botFaceMouthPoints, botFaceMouthLine, botFaceSegDistance, botFaceMouthWidth, botFaceBeads, botFaceMouthStrokes, botFaceStrokesDistance, botFaceStrokeBeads, type BotFaceGeometry, type BotFaceMood };
/** The mutter's step: which of the working mouth's three dots is raised (lab R9), or none (the still "…"). */
export type BotFaceMutter = 0 | 1 | 2;
/** A mood's mouth; working takes the mutter's raised dot when one is given. */
export function botFaceMoodMouth(mood: BotFaceMood, mutter?: BotFaceMutter | null): Mouth {
  const mouth = BOT_FACE_MOUTHS[mood];
  return mutter == null || !mouth.dots ? mouth : { ...mouth, lift: [0, 1, 2].map(i => (i === mutter ? 1 : 0)) };
}
/** Fields live with their artwork's outline, shared by consumers of that live art rather than retained per edit. */
const GEOMETRY = new WeakMap<BotFaceBodyArt['fill'], Map<string, BotFaceGeometry>>();
export function botFaceGeometry(_key: string, body: BotFaceBodyArt, hinted: boolean, centreOf?: BotFaceGeometry): BotFaceGeometry {
  const artKey = botFaceArtHash(body);
  const id = `${artKey}${hinted ? '~s' : ''}${centreOf ? `@${centreOf.cy}` : ''}`;
  let variants = GEOMETRY.get(body.fill);
  if (!variants) { variants = new Map(); GEOMETRY.set(body.fill, variants); }
  const known = variants.get(id);
  if (known) return known;
  const centre = centreOf ?? (hinted ? botFaceGeometry('', body, false) : undefined);
  const geometry = createBotFaceGeometry(hinted ? hintBody(body) : body, centre);
  variants.set(id, geometry);
  return geometry;
}
export const botFaceMoonGeometry = () => botFaceGeometry('moon', BOT_FACE_MOON, false);

export function botFaceMorphAt(
  body: BotFaceBodyId,
  mood: BotFaceMood,
  t: number,
  rest: boolean,
): Readonly<{ to: BotFaceMorphId; amount: number }> | null {
  const morph = BOT_FACE_MORPHS[body];
  if (!morph || (mood !== 'working' && mood !== 'needsYou')) return null;
  if (mood === 'needsYou') return { to: morph.needsYou, amount: rest ? 1 : clamp01(t / 300) };
  return rest ? null : { to: morph.working, amount: 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 900) };
}
/** The body's field blended toward a limb pose: one frame's geometry, sharing the body's outline box and mouth. */
export function botFaceMorphGeometry(
  G: BotFaceGeometry,
  body: BotFaceBodyId,
  morph: Readonly<{ to: BotFaceMorphId; amount: number }>,
  hinted: boolean,
): BotFaceGeometry {
  if (morph.amount <= 0) return G;
  const to = botFaceGeometry(morph.to, BOT_FACE_MORPH_ART[morph.to], hinted, botFaceGeometry(body, BOT_FACE_BODIES[body], false));
  const sdf = new Float32Array(G.sdf.length);
  for (let i = 0; i < sdf.length; i++) sdf[i] = G.sdf[i] + (to.sdf[i] - G.sdf[i]) * morph.amount;
  return { ...G, sdf, top: Math.min(G.top, to.top), bot: Math.max(G.bot, to.bot), ext: Math.max(G.ext, to.ext) };
}

/* ═══ poses: pure functions of (mood, ms since the moment began, seed); stills and moments share the maths ═══ */
export type BotFacePose = Readonly<{
  yaw: number;
  pitch: number;
  roll: number;
  ty: number;
  sx: number;
  sy: number;
  breath: number;
  gain: number;
  /** The done moment's full turn about the vertical axis (radians, 0 outside it); added to `yaw`, never halved. */
  spin: number;
  mouth: Mouth;
}>;
export const BOT_FACE_DONE_MS = 1900;
export function botFaceHash(seed: number, k: number): number {
  let x = Math.imul((seed | 0) ^ Math.imul(k, 2654435761), 2246822519);
  x ^= x >>> 15;
  x = Math.imul(x, 3266489917);
  x ^= x >>> 13;
  return ((x >>> 0) % 10000) / 10000;
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
function keyframes(
  t: number,
  keys: readonly (readonly [number, number])[],
): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [tb, vb] = keys[i],
      [ta, va] = keys[i - 1];
    if (t <= tb) return va + (vb - va) * easeInOut((t - ta) / (tb - ta || 1));
  }
  return keys[keys.length - 1][1];
}
/** The list pose: still, a fixed gentle three-quarter turn per mood (lab `still`). */
export function botFaceListPose(mood: BotFaceMood, mutter?: BotFaceMutter | null): BotFacePose {
  // Needs you is cocked toward the page (R10 A §1: roll 0.12, pitch −0.08) in every motion mode.
  const cocked = mood === 'needsYou' ? botFaceMotionTokens.alive.needsYou : null;
  return {
    yaw: mood === 'needsYou' ? 0.1 : 0.24,
    pitch: (mood === 'working' ? 0.16 : 0.08) + (cocked?.pitch ?? 0),
    roll: cocked?.roll ?? 0,
    ty: 0,
    sx: 1,
    sy: 1,
    breath: 0,
    gain: 1,
    spin: 0,
    mouth: botFaceMoodMouth(mood, mutter),
  };
}
/**
 * The hero pose (round 4's gentle pose: the R2 pose with turn and nod halved) at `t` ms into a finite moment.
 * `t` past the moment's end is its resting pose; nothing here loops.
 */
export function botFaceHeroPose(
  mood: BotFaceMood,
  t: number,
  seed: number,
  rest = false,
): BotFacePose {
  if (rest && mood === 'done') mood = 'quiet';
  // A resting pose drops every periodic term; a moment samples them.
  const live = rest ? 0 : 1;
  const r1 = botFaceHash(seed, 1),
    r2 = botFaceHash(seed, 2);
  const side = r1 < 0.5 ? -1 : 1;
  const s = t / 1000;
  let yaw =
    side * (0.2 + 0.12 * r2) + live * 0.34 * Math.sin(2 * Math.PI * (s / 9.6 + r2));
  let pitch = 0.1 + live * 0.03 * Math.sin(2 * Math.PI * (s / 7.3 + r1));
  let roll = 0,
    ty = 0,
    sx = 1,
    sy = 1,
    gain = 1,
    spin = 0;
  let mouth: Mouth = BOT_FACE_MOUTHS[mood];
  const breath = live * Math.sin(2 * Math.PI * (s / 4.8 + r1)) * 0.012;
  if (mood === 'working') {
    mouth = BOT_FACE_MOUTHS.working;
    pitch = 0.2 + live * 0.035 * Math.sin((2 * Math.PI * s) / 1.6);
    yaw = side * 0.14 + live * 0.1 * Math.sin((2 * Math.PI * s) / 5.2);
  } else if (mood === 'needsYou') {
    const a = rest ? 1 : easeOut(s / 0.26);
    gain = 1 + 0.18 * a;
    pitch += (-0.16 - pitch) * a;
    yaw += (side * 0.06 - yaw) * a;
    roll = side * -0.07 * a;
    mouth = { w: 1, d: 1, o: a, y: -0.03 * a };
    if (!rest) ty = keyframes(t, [
      [0, 0],
      [140, -0.16],
      [360, 0],
      [460, 0],
    ]);
    if (!rest) sy = keyframes(t, [
      [0, 1],
      [140, 1.05],
      [360, 0.95],
      [460, 1],
    ]);
    if (!rest) sx = keyframes(t, [
      [0, 1],
      [140, 0.97],
      [360, 1.04],
      [460, 1],
    ]);
  } else if (mood === 'done') {
    ty = keyframes(t, [
      [0, 0],
      [140, 0.03],
      [420, -0.24],
      [640, 0],
      [760, 0],
    ]);
    sy = keyframes(t, [
      [0, 1],
      [140, 0.92],
      [420, 1.05],
      [640, 0.95],
      [800, 1],
    ]);
    sx = keyframes(t, [
      [0, 1],
      [140, 1.06],
      [420, 0.97],
      [640, 1.04],
      [800, 1],
    ]);
    const g = keyframes(t, [
      [0, 0],
      [300, 1],
      [1500, 1],
      [1900, 0],
    ]);
    mouth = { w: 1 + 0.14 * g, d: 1 + 0.5 * g, o: 0, y: 0 };
    gain = 1 + 0.12 * g;
    spin = keyframes(t, [
      [0, 0],
      [140, 0],
      [900, 2 * Math.PI],
      [BOT_FACE_DONE_MS, 2 * Math.PI],
    ]) % (2 * Math.PI);
  }
  return {
    yaw: yaw * 0.5,
    pitch: pitch * 0.6,
    roll,
    ty,
    sx,
    sy,
    breath,
    gain,
    spin,
    mouth,
  };
}
