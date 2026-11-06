import type { BotMotion } from '@happier-dev/protocol/account/settings/accountSettings';

import type { BotFaceMood, BotFaceMutter } from './botFaceGeometry';
import { botFaceMotionTokens, type BotFaceIdleGesture } from './botFaceMotionTokens';

/**
 * The attention clock (R10 A, DECISIONS-R10.md §1 and §3.6, without eyes): one shared clock for every mounted list face,
 * whatever surface hosts it. Each registered face carries a small brain: where it looks next, a body that follows on
 * damped springs, its state as behaviour (a bowed, nodding worker; a cocked head that needs you; a downcast failure), its
 * R7 idle gestures and R9's working mutter.
 *
 * Cost contract: the clock steps only faces that are moving, due an event or newly passed by the pointer, at 30 Hz, and
 * otherwise sleeps on one timer until the earliest scheduled event. A face registers only while it is visible, its host
 * is viewed and its mode is Lively or Reactions only, so Still, Reduce motion, hidden and offscreen faces schedule
 * nothing. In Reactions only a resting face has no events at all; only the pointer wakes it.
 */

/** What a face draws from its brain, quantised to the drawing's steps: the head turn (radians) and the mutter step. */
export type BotFaceLook = Readonly<{ yaw: number; pitch: number; roll: number; mutter: BotFaceMutter | null }>;
export const BOT_FACE_LOOK_REST: BotFaceLook = { yaw: 0, pitch: 0, roll: 0, mutter: null };
/**
 * How a style shows a turn: `full` redraws the turned body (Dither, Solid); `slide` slides Dots' smile (no roll);
 * `look` steps Pixel's face rows one sprite pixel (`yaw` is then −1, 0 or 1); `none` does not turn (Planet).
 */
export type BotFaceTurnKind = 'full' | 'slide' | 'look' | 'none';
export type BotFaceBrainFace = Readonly<{
  seed: number;
  mode: Extract<BotMotion, 'lively' | 'reactions'>;
  turns: BotFaceTurnKind;
  mood: BotFaceMood;
  /** A hero (48 px and up): turns in the hero step and plays no idle gestures (its moments are its own). */
  hero?: boolean;
  onLook: (look: BotFaceLook) => void;
  /** An R7 idle gesture is due; the face ignores it while one of its reactions plays. */
  onGesture: (gesture: BotFaceIdleGesture) => void;
  /** The face's centre in viewport css px, for pointer attention (web and desktop); null where there is none. */
  locate?: () => Readonly<{ x: number; y: number }> | null;
}>;
export type BotFaceBrainHandle = Readonly<{
  /** The face's mood. `fact`: it changed now (a failure then shakes its head). */
  setMood: (mood: BotFaceMood, fact: boolean) => void;
  /** Keyboard focus on the Bot's pin or row: it looks at you (chin up) for as long as it holds focus. */
  setFocused: (focused: boolean) => void;
  release: () => void;
}>;

const T = botFaceMotionTokens.alive;
const M = botFaceMotionTokens.mutter;
const GESTURES: readonly BotFaceIdleGesture[] = ['smile', 'wiggle', 'sigh'];

/** Seeded randomness (robot-heads' generator, as the lab): the same Bot behaves the same wherever it stands. */
function rng(seed: number): () => number {
  let t = (Math.imul(seed | 0, 2654435761) >>> 0) || 1;
  return () => {
    t = (t + 1831565813) >>> 0;
    let s = t;
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, range: readonly [number, number]) => range[0] + r() * (range[1] - range[0]);
const q = (v: number, step: number) => Math.round(v / step) * step + 0; // + 0 folds -0 into 0
const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** A damped harmonic oscillator per channel (robot-heads' `it`), integrated at 120 Hz. */
type Spring = { x: number; v: number };
function stepSpring(s: Spring, target: number, dt: number) {
  const w = 2 * Math.PI * T.body.hz;
  s.v += (w * w * (target - s.x) - 2 * T.body.damping * w * s.v) * dt;
  s.x += s.v * dt;
}
/** Settled below half a drawing step: the spring snaps and stops costing anything. */
const settled = (s: Spring, target: number) => Math.abs(target - s.x) < 0.01 && Math.abs(s.v) < 0.05;

class Brain {
  readonly r: () => number;
  readonly yaw: Spring = { x: 0, v: 0 };
  readonly pitch: Spring = { x: 0, v: 0 };
  readonly roll: Spring = { x: 0, v: 0 };
  look = { yaw: 0, pitch: 0 };
  nextLook: number;
  nextGesture: number;
  nextNod = Infinity;
  /** When the mutter next changes step, as of this face's last step. */
  mutterDue = Infinity;
  shakeAt = -Infinity;
  attention = 0;
  gaze = { x: 0, y: 0 };
  awake = true;
  focused = false;
  lastStep = 0;
  pointerSeen = -1;
  emitted = '';
  constructor(public face: BotFaceBrainFace, now: number) {
    this.r = rng(face.seed * 7919 + 1);
    this.nextLook = now + between(this.r, T.look.firstWithinMs);
    this.nextGesture = now + between(this.r, T.gesture.firstWithinMs);
    this.scheduleNod(now);
  }
  get lively() { return this.face.mode === 'lively'; }
  scheduleNod(now: number) {
    const mood = this.face.mood;
    this.nextNod = !this.lively ? Infinity
      : mood === 'needsYou' ? now + between(this.r, T.needsYou.nodEveryMs)
      : mood === 'working' ? now + Math.round(between(this.r, T.working.nodEveryPeriods)) * M.periodMs
      : Infinity;
  }
  /** The mutter step at `now`: each Bot's phase is offset by its seed, so a rail of workers never marches in step. */
  mutterAt(now: number): BotFaceMutter | null {
    if (!this.lively || this.face.mood !== 'working') return null;
    const i = Math.floor(((now + this.face.seed * 97) % M.periodMs) / M.stepMs);
    return i < 3 ? (i as BotFaceMutter) : null;
  }
  nextMutter(now: number): number {
    if (!this.lively || this.face.mood !== 'working') return Infinity;
    const p = (now + this.face.seed * 97) % M.periodMs;
    return now + (p < 3 * M.stepMs ? M.stepMs - (p % M.stepMs) : M.periodMs - p);
  }
  /** The earliest time this face needs a step while it rests; Infinity when it has none (Reactions only). */
  nextEvent(): number {
    if (!this.lively) return Infinity;
    const mood = this.face.mood;
    const looks = mood === 'quiet' || mood === 'done' || mood === 'failed' ? this.nextLook : Infinity;
    const gestures = mood === 'quiet' && !this.face.hero ? this.nextGesture : Infinity;
    return Math.min(looks, gestures, this.nextNod, this.mutterDue);
  }
  /** Advance to `now`; returns whether anything still moves (the clock keeps stepping this face at 30 Hz). */
  step(now: number, dt: number, pointer: Readonly<{ x: number; y: number }> | null): boolean {
    const mood = this.face.mood, live = this.lively;
    let moving = false;
    let tYaw = 0, tPitch = 0, tRoll = 0;
    if (live) {
      const slow = mood === 'failed' ? T.failed.lookSlow : mood === 'done' ? T.done.lookSlow : 1;
      if (now >= this.nextLook && (mood === 'quiet' || mood === 'done' || mood === 'failed')) {
        this.look = this.r() < T.look.centreShare ? { yaw: 0, pitch: 0 }
          : { yaw: (this.r() - 0.5) * 2 * T.look.yaw, pitch: (this.r() - 0.5) * 2 * T.look.pitch };
        this.nextLook = now + between(this.r, T.look.everyMs) * slow;
      }
      if (now >= this.nextGesture && mood === 'quiet' && !this.face.hero) {
        this.face.onGesture(GESTURES[Math.floor(this.r() * GESTURES.length)]!);
        this.nextGesture = now + between(this.r, T.gesture.everyMs);
      }
      if (now >= this.nextNod) {
        this.pitch.v += mood === 'needsYou' ? T.needsYou.nodV : T.working.nodV;
        this.scheduleNod(now);
      }
      if (mood === 'working') tPitch = T.working.pitch;
      // Needs you is cocked in its list pose in every mode (botFaceListPose); Lively adds only the nods.
      else if (mood === 'needsYou') { tRoll = 0; tPitch = 0; }
      else if (mood === 'failed') { tYaw = this.look.yaw * 0.5; tPitch = T.failed.pitch + this.look.pitch * 0.3; }
      else { tYaw = this.look.yaw; tPitch = this.look.pitch; tRoll = this.look.yaw * T.look.rollPerYaw; }
    }
    if (this.focused) { tYaw = 0; tPitch = T.focus.pitch; tRoll = 0; }
    // The pointer, Lively and Reactions only: looking at the person is a reaction to them (oba's soft tanh reach).
    let goal: { x: number; y: number } | null = null;
    const centre = pointer ? this.face.locate?.() : null;
    if (pointer && centre) {
      const dx = (pointer.x - centre.x) / T.pointer.reachPx, dy = (pointer.y - centre.y) / T.pointer.reachPx, m = Math.hypot(dx, dy);
      if (m < 1.6 && m > 1e-6) { const k = Math.tanh(m) / m; goal = { x: dx * k, y: dy * k }; }
    }
    const kF = 1 - Math.exp(-dt / (goal ? T.pointer.tauMs : T.pointer.attendTauMs)), kA = 1 - Math.exp(-dt / T.pointer.attendTauMs);
    const gx = goal ? goal.x : this.gaze.x, gy = goal ? goal.y : this.gaze.y;
    const before = { a: this.attention, x: this.gaze.x, y: this.gaze.y };
    this.gaze.x += (gx - this.gaze.x) * kF; this.gaze.y += (gy - this.gaze.y) * kF;
    this.attention += ((goal ? 1 : 0) - this.attention) * kA;
    if (Math.abs(this.attention - (goal ? 1 : 0)) < 0.003) this.attention = goal ? 1 : 0;
    if (Math.abs(this.attention - before.a) > 1e-4 || Math.abs(this.gaze.x - before.x) > 0.003 || Math.abs(this.gaze.y - before.y) > 0.003) moving = true;
    const a = smooth(this.attention);
    if (a > 0) {
      const share = mood === 'working' ? T.pointer.workingShare : 1; // a worker glances but keeps its head on the work
      tYaw += (this.gaze.x * T.pointer.yaw - tYaw) * a * share;
      tPitch += (this.gaze.y * T.pointer.pitch - tPitch) * a * share;
    }
    // The failed head shake, on the fact only (robot-heads' error: 0.22 · sin(7πu)(1 − u) over 700 ms).
    let shake = 0;
    const u = (now - this.shakeAt) / T.failed.shakeMs;
    if (u >= 0 && u < 1) { shake = T.failed.shakeYaw * Math.sin(u * Math.PI * 7) * (1 - u); moving = true; }
    const sub = Math.max(1, Math.ceil(dt / (1000 / 120))), h = dt / 1000 / sub;
    for (let i = 0; i < sub; i++) { stepSpring(this.yaw, tYaw, h); stepSpring(this.pitch, tPitch, h); stepSpring(this.roll, tRoll, h); }
    if (settled(this.yaw, tYaw) && settled(this.pitch, tPitch) && settled(this.roll, tRoll)) {
      this.yaw.x = tYaw; this.yaw.v = 0; this.pitch.x = tPitch; this.pitch.v = 0; this.roll.x = tRoll; this.roll.v = 0;
    } else moving = true;
    this.emit(now, shake);
    this.mutterDue = this.nextMutter(now);
    this.lastStep = now;
    return moving;
  }
  emit(now: number, shake = 0) {
    const yaw = this.yaw.x + shake, kind = this.face.turns, step = this.face.hero ? T.heroTurnStep : T.turnStep;
    const look: BotFaceLook = kind === 'full' ? { yaw: q(yaw, step), pitch: q(this.pitch.x, step), roll: q(this.roll.x, this.face.hero ? T.heroTurnStep : T.rollStep), mutter: this.mutterAt(now) }
      : kind === 'slide' ? { yaw: q(yaw, T.turnStep), pitch: q(this.pitch.x, T.turnStep), roll: 0, mutter: this.mutterAt(now) }
      : kind === 'look' ? { yaw: yaw >= 0.12 ? 1 : yaw <= -0.12 ? -1 : 0, pitch: 0, roll: 0, mutter: this.mutterAt(now) }
      : { ...BOT_FACE_LOOK_REST, mutter: this.mutterAt(now) };
    const key = `${look.yaw}|${look.pitch}|${look.roll}|${look.mutter}`;
    if (key === this.emitted) return;
    const first = this.emitted === '';
    this.emitted = key;
    if (!first || key !== `0|0|0|null`) this.face.onLook(look);
  }
}

const faces = new Set<Brain>();
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let pointer: { x: number; y: number } | null = null;
let pointerAt = 0;
let listening = false;

function onPointerMove(event: PointerEvent) {
  if (event.pointerType === 'touch') return;
  pointer = { x: event.clientX, y: event.clientY };
  pointerAt = Date.now();
  wake();
}
function onPointerLeave() {
  pointer = null;
  pointerAt = Date.now();
  wake();
}
function listen(on: boolean) {
  if (on === listening || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  listening = on;
  if (on) {
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement?.addEventListener('pointerleave', onPointerLeave);
  } else {
    document.removeEventListener('pointermove', onPointerMove);
    document.documentElement?.removeEventListener('pointerleave', onPointerLeave);
    pointer = null;
  }
}

function tick() {
  timer = null;
  ticking = false;
  const now = Date.now();
  let awake = false;
  for (const brain of faces) {
    const touched = brain.pointerSeen < pointerAt && brain.face.locate !== undefined;
    if (!brain.awake && !touched && brain.attention === 0 && brain.nextEvent() > now) continue;
    const dt = brain.awake && brain.lastStep ? Math.min(100, now - brain.lastStep) : T.tickMs;
    brain.pointerSeen = pointerAt;
    brain.awake = brain.step(now, dt, pointer);
    if (brain.awake) awake = true;
  }
  if (awake) { ticking = true; timer = setTimeout(tick, T.tickMs); return; }
  sleep(now);
}
/** Nothing moves: one timer until the earliest scheduled event, or none at all. */
function sleep(now: number) {
  let next = Infinity;
  for (const brain of faces) next = Math.min(next, brain.nextEvent());
  if (next < Infinity) timer = setTimeout(tick, Math.max(0, next - now));
}
function wake() {
  if (ticking || faces.size === 0) return;
  if (timer !== null) clearTimeout(timer);
  ticking = true;
  timer = setTimeout(tick, 0);
}

/**
 * Register a visible, eligible face. Removing the last face removes the clock and the pointer listener. A face's mode is
 * fixed for its registration; a mode change re-registers it.
 */
export function registerBotFaceBrain(face: BotFaceBrainFace): BotFaceBrainHandle {
  const now = Date.now();
  const brain = new Brain(face, now);
  brain.lastStep = now;
  faces.add(brain);
  if (face.locate) listen(true);
  wake();
  return {
    setMood(mood, fact) {
      if (brain.face.mood === mood) return;
      brain.face = { ...brain.face, mood };
      const at = Date.now();
      brain.scheduleNod(at);
      if (fact && mood === 'failed' && brain.lively) brain.shakeAt = at;
      brain.awake = true;
      wake();
    },
    setFocused(focused) {
      if (brain.focused === focused) return;
      brain.focused = focused;
      brain.awake = true;
      wake();
    },
    release() {
      faces.delete(brain);
      if (faces.size > 0) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ticking = false;
      listen(false);
    },
  };
}
