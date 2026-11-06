import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { botFaceMotionChannels, botFaceMotionPose } from './botFaceMotionTokens';
import { readSessionBotFaceFacts } from './sessionBotFaceFacts';
import { BOT_FACE_MOUTHS } from './botFaceGeometry';
import { drawBotFaceRaster } from './botFaceRaster';

afterEach(() => vi.useRealTimers());

it('lands the hop and droop at their R7 poses, and retargets an interruption from the current pose', () => {
  expect(botFaceMotionPose('working', 80, 24)).toMatchObject({ sx: 1.06, sy: 0.9 });
  expect(botFaceMotionPose('working', 230, 24).y).toBeCloseTo(-2.4);
  expect(botFaceMotionPose('working', 870, 24)).toEqual({ x: 0, y: 0, rotation: 0, sx: 1, sy: 1 });
  expect(botFaceMotionPose('failed', 360, 24)).toMatchObject({ y: 0.96, sx: 1.03, sy: 0.94, rotation: -3 });
  const current = botFaceMotionChannels('working', 150);
  expect(botFaceMotionChannels('needsYou', 0, current)).toEqual(current);
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
