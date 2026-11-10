import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { SessionForkRpcParamsSchema } from './fork.js';
import { SessionContinueWithReplayRequestSchema } from './continueWithReplay.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
  HappierReplayWritableMaxSeedCharsSchema,
  HAPPIER_REPLAY_MIN_SEED_CHARS,
} from './replaySeedBudget.js';

describe('Replay seed budget bounds', () => {
  it.each([1024, 2002, 120_000, 512 * 1024])('accepts the usable budget %s without a provider safety ceiling', (budget) => {
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(budget).success).toBe(true);
    expect(HappierReplayWireMaxSeedCharsSchema.safeParse(budget).success).toBe(true);
  });

  it.each([1])('refuses a new preference that cannot contain a seed at %s, while reading the retained wire budget', budget => {
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(budget).success).toBe(false);
    expect(HappierReplayWireMaxSeedCharsSchema.safeParse(budget).success).toBe(true);
    expect(accountSettingsParse({ sessionReplayMaxSeedChars: budget }).sessionReplayMaxSeedChars).toBe(120_000);
  });

  it('admits the derived minimum and rejects the immediately smaller preference', () => {
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_MIN_SEED_CHARS).success).toBe(true);
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_MIN_SEED_CHARS - 1).success).toBe(false);
    expect(accountSettingsParse({ sessionReplayMaxSeedChars: HAPPIER_REPLAY_MIN_SEED_CHARS }).sessionReplayMaxSeedChars)
      .toBe(HAPPIER_REPLAY_MIN_SEED_CHARS);
  });

  it('rejects nonpositive or noninteger budgets', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(invalid).success).toBe(false);
      expect(HappierReplayWireMaxSeedCharsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts a selected aggregate count beyond one transcript page while rejecting invalid counts', () => {
    expect(HappierReplayRecentMessagesCountSchema.safeParse(620).success).toBe(true);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(HappierReplayRecentMessagesCountSchema.safeParse(invalid).success).toBe(false);
    }
    expect(SessionContinueWithReplayRequestSchema.safeParse({
      previousSessionId: 'previous', recentMessagesCount: 620,
    }).success).toBe(true);
  });
});

describe('Replay budget owners derive from the one bound', () => {
  it.each([120_000, 512 * 1024])('retains the selected usable stored budget %s', (budget) => {
    expect(accountSettingsParse({ sessionReplayMaxSeedChars: budget }).sessionReplayMaxSeedChars).toBe(budget);
  });

  it('retains a selected stored aggregate count beyond one transcript page', () => {
    expect(accountSettingsParse({ sessionReplayRecentMessagesCount: 620 }).sessionReplayRecentMessagesCount)
      .toBe(620);
  });

  it('keeps the fork and continue ingresses reading the released wire range', () => {
    const fork = SessionForkRpcParamsSchema.safeParse({
      v: 1,
      parentSessionId: 'parent',
      forkPoint: { type: 'latest' },
      replayMaxSeedChars: 500,
    });
    expect(fork.success).toBe(true);

    const continued = SessionContinueWithReplayRequestSchema.safeParse({
      previousSessionId: 'previous',
      maxSeedChars: 500,
    });
    expect(continued.success).toBe(true);
  });
});
