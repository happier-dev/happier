/**
 * R7 artwork contract: .happier/design-lab/living-bots/DECISIONS-R7.md. R10 A (DECISIONS-R10.md §1, owner 2026-11-04):
 * the per-Bot attention brain without eyes (`alive`) replaces R7's breath and its one-Bot-at-a-time idle scheduler;
 * working is R9's mutter (DECISIONS-R9.md §2).
 */
export type BotFaceChannels = Readonly<{ tx: number; ty: number; sx: number; sy: number; rot: number }>;
type Moment = Readonly<{
  mouthAtMs?: number; mouthBackAtMs?: number; markerAtMs?: number;
  settle: Readonly<{ duration: number; dampingRatio: number }>;
  keys: readonly (readonly [number, Partial<BotFaceChannels>, 'standard' | 'exit'])[];
}>;
export const botFaceMotionTokens = {
  stageScale: 1.5, heroTranslate: 0.75, mouthMorphMs: 90, stillCrossFadeMs: 120,
  reactions: {
    startsWorking: { mouthAtMs: 150, markerAtMs: 360, settle: { duration: 300, dampingRatio: 0.6 },
      keys: [[80, { sy: 0.9, sx: 1.06 }, 'standard'], [150, { ty: -0.1, sy: 1.06, sx: 0.96 }, 'standard'], [130, { ty: 0, sy: 1, sx: 1 }, 'exit'], [60, { sy: 0.93, sx: 1.04 }, 'standard']] },
    needsYou: { mouthAtMs: 60, markerAtMs: 90, settle: { duration: 280, dampingRatio: 0.5 },
      keys: [[90, { rot: 8, tx: 0.04, ty: -0.03 }, 'standard'], [110, { rot: -2, tx: 0, ty: 0 }, 'standard'], [90, { rot: 5, tx: 0.025 }, 'standard']] },
    completes: { mouthAtMs: 70, markerAtMs: 0, settle: { duration: 320, dampingRatio: 0.55 },
      keys: [[70, { sy: 0.9, sx: 1.06 }, 'standard'], [160, { ty: -0.14, sy: 1.07, sx: 0.95, rot: -4 }, 'standard'], [140, { ty: 0, sy: 1, sx: 1, rot: 0 }, 'exit'],
        [60, { sy: 0.92, sx: 1.05 }, 'standard'], [120, { ty: -0.06, sy: 1.03, sx: 0.98, rot: 3 }, 'standard'], [110, { ty: 0, sy: 1, sx: 1, rot: 0 }, 'exit']] },
    fails: { mouthAtMs: 120, markerAtMs: 0, settle: { duration: 420, dampingRatio: 1 },
      keys: [[360, { ty: 0.04, sy: 0.94, sx: 1.03, rot: -3 }, 'standard'], [260, {}, 'standard']] },
  },
  /**
   * Hover perk (owner 2026-11-02): a smaller hop than a fact's, a brief grin, then back to the resting mouth. Its
   * stretch stays at Pixel's 1.02 step so a Pixel Bot hops one sprite pixel, not two.
   */
  perk: { mouthAtMs: 60, mouthBackAtMs: 520, settle: { duration: 260, dampingRatio: 0.6 },
    keys: [[70, { sy: 0.95, sx: 1.03 }, 'standard'], [130, { ty: -0.07, sy: 1.02, sx: 0.985 }, 'standard'], [120, { ty: 0, sy: 1, sx: 1 }, 'exit']] },
  idle: {
    smile: { mouthAtMs: 0, mouthBackAtMs: 640, settle: { duration: 320, dampingRatio: 1 }, keys: [[140, { sy: 1.03, sx: 0.99 }, 'standard'], [500, {}, 'standard']] },
    wiggle: { settle: { duration: 240, dampingRatio: 0.7 }, keys: [[90, { rot: 3 }, 'standard'], [90, { rot: -3 }, 'standard'], [90, { rot: 1.5 }, 'standard']] },
    sigh: { settle: { duration: 360, dampingRatio: 1 }, keys: [[380, { sy: 1.04, sx: 0.985 }, 'standard'], [420, { sy: 0.965, sx: 1.02 }, 'standard']] },
  },
  /** R9: the working "…" mouth's dots rise one after another (200 ms each), then rest on "…" until the period ends. */
  mutter: { periodMs: 1400, stepMs: 200 },
  /** R10 A, Lively only. Sign convention: yaw positive turns toward the page, pitch positive bows. Radians, ms. */
  alive: {
    look: { everyMs: [1800, 4600], centreShare: 0.4, yaw: 0.3, pitch: 0.1, rollPerYaw: -0.16, firstWithinMs: [400, 2600] },
    body: { hz: 1.3, damping: 0.62 },
    pointer: { reachPx: 260, yaw: 0.32, pitch: 0.18, tauMs: 120, attendTauMs: 300, workingShare: 0.35 },
    working: { pitch: 0.06, nodEveryPeriods: [3, 5], nodV: 0.7 },
    /** Cocked toward the page: drawn in the needs-you list pose in every mode; Lively adds the nods. */
    needsYou: { roll: 0.12, pitch: -0.08, nodEveryMs: [2600, 4600], nodV: 0.9 },
    /** Keyboard focus on its pin or row: eyes forward, chin up. */
    focus: { pitch: -0.04 },
    /** Heroes (48 px and up): a finer turn step and a breath of 1.2% over 3.4 s (oba). */
    heroTurnStep: 0.04, heroBreath: { periodMs: 3400, sy: 0.012 },
    failed: { shakeMs: 700, shakeYaw: 0.22, pitch: 0.1, lookSlow: 2 },
    done: { lookSlow: 1.4 },
    gesture: { everyMs: [14_000, 40_000], firstWithinMs: [6000, 28_000] },
    /** One drawing per 0.05 rad of turn; roll in 0.04 rad (it follows yaw at rest, so finer steps only add drawings). The clock steps moving faces at 30 Hz (MonoCode's pulse). */
    turnStep: 0.05, rollStep: 0.04, tickMs: 33,
  },
} as const;
export type BotFaceIdleGesture = keyof typeof botFaceMotionTokens.idle;
export type BotFaceReaction = 'working' | 'needsYou' | 'done' | 'failed' | 'perk' | BotFaceIdleGesture;
export const BOT_FACE_REST: BotFaceChannels = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
const moments: Readonly<Record<BotFaceReaction, Moment>> = {
  working: botFaceMotionTokens.reactions.startsWorking,
  needsYou: botFaceMotionTokens.reactions.needsYou,
  done: botFaceMotionTokens.reactions.completes,
  failed: botFaceMotionTokens.reactions.fails,
  perk: botFaceMotionTokens.perk,
  ...botFaceMotionTokens.idle,
};
export function botFaceMoment(kind: BotFaceReaction): Moment {
  'worklet';
  return moments[kind];
}
export function botFaceMomentMs(kind: BotFaceReaction): number {
  'worklet';
  const moment = moments[kind];
  return moment.keys.reduce((sum, key) => sum + key[0], 0) + 1.5 * moment.settle.duration;
}
/** CSS bezier semantics, as in the R7 reference sampler; the product's standard and exit curves. */
function ease(progress: number, curve: 'standard' | 'exit'): number {
  'worklet';
  const x1 = curve === 'standard' ? 0.2 : 0.4;
  const x2 = curve === 'standard' ? 0 : 1;
  let lo = 0, hi = 1, t = progress;
  for (let i = 0; i < 24; i++) {
    const u = 1 - t;
    const x = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
    if (Math.abs(x - progress) < 0.00001) break;
    if (x < progress) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return 3 * (1 - t) * t * t + t * t * t;
}
function spring(moment: Moment, elapsed: number): number {
  'worklet';
  const duration = 1.5 * moment.settle.duration, z = moment.settle.dampingRatio;
  if (elapsed >= duration) return 0;
  if (z >= 1) { const w = 8.3 / duration; return (1 + w * elapsed) * Math.exp(-w * elapsed); }
  const w = 5.8 / (z * duration), wd = w * Math.sqrt(1 - z * z);
  return Math.exp(-z * w * elapsed) * (Math.cos(wd * elapsed) + z * w / wd * Math.sin(wd * elapsed));
}
export function botFaceMotionChannels(kind: BotFaceReaction | null, elapsed: number, from = BOT_FACE_REST): BotFaceChannels {
  'worklet';
  if (!kind) return BOT_FACE_REST;
  const moment = moments[kind];
  let value = from, at = 0;
  for (const [duration, target, curve] of moment.keys) {
    const next = { ...value, ...target };
    if (elapsed < at + duration) {
      const u = ease(Math.max(0, (elapsed - at) / duration), curve);
      return { tx: value.tx + (next.tx - value.tx) * u, ty: value.ty + (next.ty - value.ty) * u,
        sx: value.sx + (next.sx - value.sx) * u, sy: value.sy + (next.sy - value.sy) * u, rot: value.rot + (next.rot - value.rot) * u };
    }
    value = next; at += duration;
  }
  const k = spring(moment, elapsed - at);
  return { tx: value.tx * k, ty: value.ty * k, sx: 1 + (value.sx - 1) * k, sy: 1 + (value.sy - 1) * k, rot: value.rot * k };
}
/** Cached face artwork moves about its foot; Pixel keeps its sprite grid instead of stretching. */
export function botFaceMotionPose(kind: BotFaceReaction | null, elapsed: number, size: number,
  from = BOT_FACE_REST, pixel = false, spritePixel = 1) {
  'worklet';
  const p = botFaceMotionChannels(kind, elapsed, from);
  const translation = size >= 48 ? botFaceMotionTokens.heroTranslate : 1;
  let x = p.tx * size * translation, y = p.ty * size * translation;
  if (pixel) {
    x = Math.round(x / spritePixel) * spritePixel;
    y = Math.round(y / spritePixel) * spritePixel;
    if (Math.abs(p.rot) >= 3.5) x += Math.sign(p.rot) * spritePixel;
    if (p.sy < 0.95) y += spritePixel / 2;
    if (p.sy > 1.02) y -= spritePixel;
  }
  return { x, y, rotation: pixel ? 0 : p.rot, sx: pixel ? 1 : p.sx, sy: pixel ? 1 : p.sy };
}
/**
 * The two mouth layers of a swap: the outgoing face stays opaque underneath and only the incoming one fades over it
 * (R8: fading both ghosted the whole face to ~75% at mid-swap). Incoming follows the moment's mouth time, back out at
 * its return time, else the resting fade (Still's cross-fade).
 */
export function botFaceMouthLayers(kind: BotFaceReaction | null, t: number, restingFade: number): { outgoing: 1; incoming: number } {
  'worklet';
  if (!kind) return { outgoing: 1, incoming: restingFade };
  const moment = moments[kind];
  let u = Math.max(0, Math.min(1, (t - (moment.mouthAtMs ?? 0)) / botFaceMotionTokens.mouthMorphMs));
  if (moment.mouthBackAtMs !== undefined) u *= 1 - Math.max(0, Math.min(1, (t - moment.mouthBackAtMs) / botFaceMotionTokens.mouthMorphMs));
  return { outgoing: 1, incoming: u };
}
/**
 * R8 direction C: the small turn a moment adds, derived from its R7 channels (no new keys); zero at rest. A lean or a
 * step sideways turns the face that way, a lift tips it up, a squash bows it.
 */
const TURN = { yawPerDeg: 0.045, yawPerTx: 4, pitchPerTy: 2.4, pitchPerSquash: 0.9, maxYaw: 0.36, maxPitch: 0.28 } as const;
export function botFaceMomentTurn(c: BotFaceChannels): { yaw: number; pitch: number } {
  'worklet';
  const clampTo = (x: number, m: number) => Math.min(m, Math.max(-m, x)) + 0; // + 0 folds -0 into 0
  return {
    yaw: clampTo(TURN.yawPerDeg * c.rot + TURN.yawPerTx * c.tx, TURN.maxYaw),
    pitch: clampTo(TURN.pitchPerTy * c.ty + TURN.pitchPerSquash * (1 - c.sy), TURN.maxPitch),
  };
}
/** Pixel's look: its face rows step one sprite pixel toward a turn of at least 0.1. */
export function botFacePixelLook(c: BotFaceChannels): -1 | 0 | 1 {
  'worklet';
  const yaw = botFaceMomentTurn(c).yaw;
  return yaw >= 0.1 ? 1 : yaw <= -0.1 ? -1 : 0;
}
/** Dots: the smile layer slides against the body with the turn, about a css pixel at the R7 extremes. */
export function botFaceSmileSlide(c: BotFaceChannels): { x: number; y: number } {
  'worklet';
  const turn = botFaceMomentTurn(c);
  return { x: turn.yaw * 2.6, y: turn.pitch * 2.6 };
}
