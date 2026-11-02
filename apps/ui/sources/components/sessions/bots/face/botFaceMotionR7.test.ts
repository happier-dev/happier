import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { botFaceMotionChannels, botFaceMotionPose } from './botFaceMotionTokens';
import { noteBotFaceReaction, registerRestingBotFace } from './botFaceIdle';
import { readSessionBotFaceFacts } from './sessionBotFaceFacts';
import { BOT_FACE_MOUTHS } from './botFaceGeometry';
import { drawBotFaceRaster } from './botFaceRaster';

afterEach(() => vi.useRealTimers());

it('starts the R7 breath at rest and reaches its asymmetric inhale after half a cycle', () => {
  expect(botFaceMotionPose(null, 0, 24, true)).toMatchObject({ sx: 1, sy: 1 });
  expect(botFaceMotionPose(null, 1600, 24, true)).toMatchObject({ sx: 0.986, sy: 1.035 });
});

it('does not schedule an idle gesture before the R7 twenty-second first delay', () => {
  vi.useFakeTimers();
  const idle = vi.fn();
  const unregister = registerRestingBotFace(idle);
  try {
    vi.advanceTimersByTime(19999);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);
  } finally { unregister(); }
});

it('lands the hop and droop at their R7 poses, and retargets an interruption from the current pose', () => {
  expect(botFaceMotionPose('working', 80, 24, false)).toMatchObject({ sx: 1.06, sy: 0.9 });
  expect(botFaceMotionPose('working', 230, 24, false).y).toBeCloseTo(-2.4);
  expect(botFaceMotionPose('working', 870, 24, false)).toEqual({ x: 0, y: 0, rotation: 0, sx: 1, sy: 1 });
  expect(botFaceMotionPose('failed', 360, 24, false)).toMatchObject({ y: 0.96, sx: 1.03, sy: 0.94, rotation: -3 });
  const current = botFaceMotionChannels('working', 150, false);
  expect(botFaceMotionChannels('needsYou', 0, false, current)).toEqual(current);
});

it('keeps one idle clock, avoids repeating the Bot or gesture, and waits through the reaction quiet window', () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  const a = vi.fn(), b = vi.fn();
  const removeA = registerRestingBotFace(a, 'a'), removeB = registerRestingBotFace(b, 'b');
  try {
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(19000); noteBotFaceReaction();
    vi.advanceTimersByTime(1000);
    expect(a).not.toHaveBeenCalled(); expect(b).not.toHaveBeenCalled();
    vi.advanceTimersByTime(7000);
    expect(a).toHaveBeenCalledExactlyOnceWith('smile');
    vi.advanceTimersByTime(25000);
    expect(b).toHaveBeenCalledExactlyOnceWith('glance');
    expect(a).toHaveBeenCalledTimes(1);
  } finally { removeA(); removeB(); random.mockRestore(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the completed grin until the existing read cursor catches up, and consumes the typed failed outcome', () => {
  const session = createSessionFixture({ id: 'r7-bot', seq: 4, lastViewedSessionSeq: 3,
    latestTurnStatus: 'completed', latestTurnStatusObservedAt: 10, lastTurnCompletedAt: null,
    metadata: { path: '/repo', host: 'tester.local', machineId: 'm', bot: { kind: 'bot' } } as ReturnType<typeof createSessionFixture>['metadata'],
  });
  expect(readSessionBotFaceFacts(session, null)).toMatchObject({ completedAt: 10, restingMood: 'done' });
  expect(readSessionBotFaceFacts({ ...session, lastViewedSessionSeq: 4, hasUnreadMessages: false }, null)).toMatchObject({ restingMood: 'quiet' });
  expect(readSessionBotFaceFacts({ ...session, latestTurnStatus: 'failed', latestTurnStatusObservedAt: 20 }, null))
    .toMatchObject({ restingMood: 'failed', failedAt: 20 });
  expect(BOT_FACE_MOUTHS).toHaveProperty('failed', { w: 0.62, d: 0.12, o: 0, y: 0.035 });
});

it('prints a white smile on the near-black ink Dither in light', () => {
  const image = drawBotFaceRaster({ identity: { body: 'bag', colour: 'ink', seed: 1 }, style: 'dither', size: 24,
    dpr: 2, theme: 'light', mood: 'quiet', monochrome: false });
  let white = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] > 230 && image.data[i + 1] > 230 && image.data[i + 2] > 230 && image.data[i + 3] === 255) white++;
  }
  expect(white).toBeGreaterThan(0);
});
