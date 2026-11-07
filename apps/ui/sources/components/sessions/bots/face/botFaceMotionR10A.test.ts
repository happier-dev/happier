import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { BOT_FACE_BODIES, PIXEL_FACE8, PIXEL_MUTTER8 } from './botFaceArt';
import {
  BOT_FACE_MOUTHS,
  botFaceGeometry,
  botFaceListPose,
  botFaceMoodMouth,
  botFaceMouthStrokes,
  type BotFaceMood,
} from './botFaceGeometry';
import {
  botFaceRestLoop,
  registerBotFaceBrain,
  type BotFaceBrainFace,
  type BotFaceLook,
} from './botFaceIdle';
import { drawBotFaceRaster } from './botFaceRaster';
import { createBotFaceScene } from './botFaceScene';
import { deriveBotFaceSprite } from './botFaceSprite';
import { generateBotFaceShape } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';

/** The clock is the only boundary: fake timers stand in for setTimeout and Date. Every timer the attention clock arms is counted. */
let armed: number[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  armed = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    armed.push(ms ?? 0);
    return real(fn, ms);
  }) as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function face(overrides: Partial<BotFaceBrainFace> = {}) {
  const looks: { at: number; look: BotFaceLook }[] = [];
  const loops: number[] = [];
  const gestures: number[] = [];
  const spec: BotFaceBrainFace = {
    seed: 5,
    mode: 'lively',
    turns: 'full',
    mood: 'quiet',
    onLook: (look) => { if (look === 'loop') loops.push(Date.now()); else looks.push({ at: Date.now(), look }); },
    onGesture: () => gestures.push(Date.now()),
    ...overrides,
  };
  return { looks, loops, gestures, handle: registerBotFaceBrain(spec) };
}

it('retains a loop only while a matching brain owns it', () => {
  const spec = { seed: 739, turns: 'full' as const, mood: 'working' as const };
  const first = face(spec).handle;
  const second = face(spec).handle;
  const loop = botFaceRestLoop(spec);
  expect(botFaceRestLoop(spec)).toBe(loop);
  first.release();
  first.release();
  expect(botFaceRestLoop(spec)).toBe(loop);
  second.release();
  const next = face(spec).handle;
  try { expect(botFaceRestLoop(spec)).not.toBe(loop); }
  finally { next.release(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('a resting Lively Bot looks somewhere new every 1.8–4.6 s as a loop, and its clock wakes only for its gestures', () => {
  for (const mood of ['quiet', 'done', 'failed'] as const) {
    const slow = mood === 'failed' ? 2 : mood === 'done' ? 1.4 : 1;
    const loop = botFaceRestLoop({ seed: 5, turns: 'full', mood });
    const at = (ms: number) => loop.drawings[[...loop.frames].reverse().find(frame => frame.atMs <= ms)!.drawing]!;
    // Each look starts a run of frames (the body springs there); between runs the drawing holds.
    const starts = loop.frames.filter((frame, index) => index === 0 || frame.atMs - loop.frames[index - 1]!.atMs > 1000).map(frame => frame.atMs);
    expect(starts.length, mood).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!, mood).toBeGreaterThanOrEqual(1800 * slow - 1);
      expect(starts[i]! - starts[i - 1]!, mood).toBeLessThanOrEqual(2 * 4600 * slow);
    }
    expect(loop.drawings.some(look => look.yaw !== 0), mood).toBe(true);
    for (const look of loop.drawings) {
      expect(Math.abs(look.yaw), mood).toBeLessThanOrEqual(0.35); // ±0.30 plus spring overshoot
      expect(Math.abs(look.pitch - (mood === 'failed' ? 0.1 : 0)), mood).toBeLessThanOrEqual(0.15);
    }
    // Seamless: it ends where it starts, settled and looking ahead.
    expect(at(loop.periodMs - 1), mood).toEqual(at(0));
  }
  const { looks, loops, handle } = face();
  try {
    vi.advanceTimersByTime(60_000);
    // It hands off at once; the clock never ticks at 30 Hz and sleeps only until its next R7 gesture.
    expect(loops).toHaveLength(1);
    expect(looks).toEqual([]);
    const ticks = armed.filter((ms) => ms === 33).length;
    expect(ticks).toBe(0);
    // A few sleeps per gesture (14–40 s apart), never a frame clock.
    expect(armed.length).toBeLessThanOrEqual(12);
    expect(vi.getTimerCount()).toBe(1);
    console.info('R10A_REST_COST', JSON.stringify({ seconds: 60, ticks, timers: armed.length, looks: looks.length }));
  } finally {
    handle.release();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('does zero work at rest in Reactions only: no timer, no draw, no gesture', () => {
  const { looks, gestures, handle } = face({ mode: 'reactions' });
  try {
    vi.advanceTimersByTime(1);
    const after = armed.length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(armed.length).toBe(after);
    expect(looks).toEqual([]);
    expect(gestures).toEqual([]);
  } finally {
    handle.release();
  }
});

it('mutters a working Lively Bot through raised dots 0, 1, 2 then rest every 1.4 s as a loop, and hands it off once settled', () => {
  for (const turns of ['full', 'slide', 'look', 'none'] as const) {
    const loop = botFaceRestLoop({ seed: 5, turns, mood: 'working' });
    // Seamless: whole mutter periods, three seeded nods 3–5 periods apart.
    expect(loop.periodMs % 1400, turns).toBe(0);
    expect(loop.periodMs / 1400, turns).toBeGreaterThanOrEqual(9);
    expect(loop.periodMs / 1400, turns).toBeLessThanOrEqual(15);
    const mutterAt = (ms: number) => loop.drawings[[...loop.frames].reverse().find(frame => frame.atMs <= ms)!.drawing]!.mutter;
    expect([100, 300, 500, 900, 1500, 1700, 1900, 2300].map(mutterAt), turns).toEqual([0, 1, 2, null, 0, 1, 2, null]);
    // A nod bows the turned styles below their working pitch for a moment, then the same drawings return.
    if (turns === 'full' || turns === 'slide') expect(new Set(loop.drawings.map(look => look.pitch)).size, turns).toBeGreaterThan(1);
    expect(loop.drawings.length, turns).toBeLessThanOrEqual(12);
  }
  const { looks, loops, handle } = face({ mood: 'working', turns: 'none', seed: 0 });
  try {
    vi.advanceTimersByTime(2000);
    expect(loops).toHaveLength(1);
    const live = looks.length;
    armed = [];
    vi.advanceTimersByTime(14_000);
    // The loop plays on the animation driver: the clock arms nothing more and emits nothing more.
    expect(looks.length).toBe(live);
    expect(armed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // Leaving work takes it back to live looks.
    handle.setMood('quiet', true);
    vi.advanceTimersByTime(100);
    expect(looks.length).toBeGreaterThan(live);
  } finally {
    handle.release();
  }
});

it('plays an R7 idle gesture per resting Bot every 14–40 s and none while it works', () => {
  const resting = face({ seed: 11 });
  const working = face({ seed: 12, mood: 'working', turns: 'none' });
  try {
    vi.advanceTimersByTime(28_000);
    expect(resting.gestures.length).toBe(1);
    vi.advanceTimersByTime(40_000);
    expect(resting.gestures.length).toBeGreaterThanOrEqual(2);
    expect(working.gestures).toEqual([]);
  } finally {
    resting.handle.release();
    working.handle.release();
  }
});

it('shakes its head once on a failure fact, then rests downcast', () => {
  const { looks, handle } = face({ seed: 3 });
  try {
    vi.advanceTimersByTime(100);
    looks.length = 0;
    handle.setMood('failed', true);
    vi.advanceTimersByTime(700);
    const yaws = looks.map(({ look }) => look.yaw);
    expect(Math.max(...yaws)).toBeGreaterThan(0.05);
    expect(Math.min(...yaws)).toBeLessThan(-0.05);
    vi.advanceTimersByTime(3000);
    expect(looks.at(-1)!.look.pitch).toBeGreaterThan(0.05);
  } finally {
    handle.release();
  }
});

it('holds needs-you cocked in every mode: the list pose carries the cock, the Lively brain adds only its nods', () => {
  const rest = botFaceListPose('quiet'), cocked = botFaceListPose('needsYou');
  expect(cocked.roll).toBeCloseTo(0.12);
  expect(cocked.pitch).toBeCloseTo(rest.pitch - 0.08);
  const { looks, handle } = face({ mood: 'needsYou', seed: 9 });
  try {
    vi.advanceTimersByTime(2500); // before the first nod (2.6–4.6 s)
    for (const { look } of looks) expect(look.roll).toBe(0);
  } finally { handle.release(); }
});

it('looks at you while its pin or row holds keyboard focus, in Lively and Reactions only, and resumes after', () => {
  for (const mode of ['lively', 'reactions'] as const) {
    const { looks, handle } = face({ mode, seed: 21 });
    try {
      vi.advanceTimersByTime(8000);
      handle.setFocused(true);
      vi.advanceTimersByTime(3000);
      const held = looks.at(-1)!.look;
      expect(held.yaw, mode).toBe(0);
      expect(held.pitch, mode).toBeLessThan(0); // chin up 0.04
      const during = looks.length;
      vi.advanceTimersByTime(10_000);
      expect(looks.length, mode).toBe(during); // it holds the look: no looking away while focused
      handle.setFocused(false);
      vi.advanceTimersByTime(3000);
      if (mode === 'reactions') expect(looks.at(-1)!.look.pitch, mode).toBe(0);
    } finally { handle.release(); }
  }
});

it('drives a hero with the same brain at the hero turn step, and stops with it', () => {
  const { loops, handle } = face({ seed: 4, hero: true });
  try {
    vi.advanceTimersByTime(30_000);
    expect(loops).toHaveLength(1);
    const turned = botFaceRestLoop({ seed: 4, turns: 'full', hero: true, mood: 'quiet' }).drawings.filter(look => look.yaw !== 0);
    expect(turned.length).toBeGreaterThan(3);
    for (const look of turned) expect(Math.abs(Math.round(look.yaw / 0.04) * 0.04 - look.yaw)).toBeLessThan(1e-9);
  } finally { handle.release(); }
  expect(vi.getTimerCount()).toBe(0);
});

/* ═══ the "…" mouth (R9) in every style ═══ */
const identity = {
  body: 'octopus' as const,
  colour: 'orchid' as const,
  seed: 5,
};
const darkCount = (data: Uint8ClampedArray, other: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 0; i < data.length; i += 4)
    if (
      data[i] !== other[i] ||
      data[i + 1] !== other[i + 1] ||
      data[i + 2] !== other[i + 2]
    )
      n++;
  return n;
};

it('draws working as three separate dots, and the mutter raises one at a time', () => {
  const G = botFaceGeometry('octopus', BOT_FACE_BODIES.octopus, true);
  const still = botFaceMouthStrokes(G, BOT_FACE_MOUTHS.working);
  expect(still).toHaveLength(3);
  for (const stroke of still) expect(stroke).toHaveLength(1);
  expect(still[1][0][1]).toBeCloseTo(still[0][0][1]);
  const raised = botFaceMouthStrokes(G, botFaceMoodMouth('working', 1));
  expect(raised[1][0][1]).toBeLessThan(still[1][0][1]);
  expect(raised[0][0][1]).toBeCloseTo(still[0][0][1]);
  expect(botFaceMoodMouth('quiet', 1)).toBe(BOT_FACE_MOUTHS.quiet);
});

it.each(['dither', 'solid', 'pixel'] as const)(
  '%s draws a still "…" distinct from rest, and each mutter step differs from it',
  (style) => {
    const draw = (mood: BotFaceMood, mutter?: 0 | 1 | 2) =>
      drawBotFaceRaster({
        identity,
        style,
        size: 24,
        dpr: 2,
        theme: 'light',
        mood,
        ...(mutter !== undefined ? { mutter } : {}),
      }).data;
    const working = draw('working');
    expect(darkCount(working, draw('quiet'))).toBeGreaterThan(0);
    for (const step of [0, 1, 2] as const)
      expect(
        darkCount(draw('working', step), working),
        `${style} ${step}`,
      ).toBeGreaterThan(0);
  },
);

it('draws "…" as three beads in Dots and Planet, spaced so they never merge', () => {
  for (const style of ['dots', 'planet'] as const) {
    const scene = (mood: BotFaceMood) =>
      createBotFaceScene({
        style,
        identity,
        size: 24,
        dpr: 2,
        theme: 'dark',
        mood,
      });
    const mouth = (s: ReturnType<typeof scene>) =>
      s.body.filter((dot) => dot.rgb[0] === 250 && dot.rgb[1] === 247);
    const beads = mouth(scene('working'));
    expect(beads, style).toHaveLength(3);
    const xs = beads.map((b) => b.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0], style).toBeGreaterThan(2 * beads[0].r);
  }
});

it('carves "…" in the hand-drawn and derived Pixel sprites, including a generated shape and the mutter', () => {
  expect(PIXEL_FACE8.working[1]).toBe('X.X.X.XX');
  expect(
    PIXEL_MUTTER8.map((rows) => rows.join('')).every(
      (rows) => rows !== PIXEL_FACE8.working.join(''),
    ),
  ).toBe(true);
  const shape = generateBotFaceShape(7);
  const still = deriveBotFaceSprite(shape, 'working', 12);
  const holes = still.grid[still.mouthRow]
    .split('')
    .filter(
      (c, i, row) =>
        c === '.' &&
        row.slice(0, i).includes('X') &&
        row.slice(i + 1).includes('X'),
    );
  expect(holes.length).toBe(3);
  expect(deriveBotFaceSprite(shape, 'working', 12, 1).grid).not.toEqual(
    still.grid,
  );
});
