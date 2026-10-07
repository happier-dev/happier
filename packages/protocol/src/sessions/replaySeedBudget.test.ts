import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { SessionForkRpcParamsSchema } from './fork.js';
import { SessionContinueWithReplayRequestSchema } from './continueWithReplay.js';
import {
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
  HappierReplayWritableMaxSeedCharsSchema,
} from './replaySeedBudget.js';

describe('Replay seed budget bounds', () => {
  it.each([1, 512 * 1024])('accepts the positive integer budget %s without a presentation floor or provider safety ceiling', (budget) => {
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(budget).success).toBe(true);
    expect(HappierReplayWireMaxSeedCharsSchema.safeParse(budget).success).toBe(true);
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
  it.each([1, 512 * 1024])('retains the selected stored budget %s beyond the old bounds', (budget) => {
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
