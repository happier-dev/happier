import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { SessionForkRpcParamsSchema } from './fork.js';
import { SessionContinueWithReplayRequestSchema } from './continueWithReplay.js';
import {
  HAPPIER_REPLAY_RECENT_MESSAGES_MAX_COUNT,
  HAPPIER_REPLAY_SEED_ACCEPTED_MIN_CHARS,
  HAPPIER_REPLAY_SEED_MAX_CHARS,
  HAPPIER_REPLAY_SEED_MIN_CHARS,
  HappierReplayRecentMessagesCountSchema,
  HappierReplayWireMaxSeedCharsSchema,
  HappierReplayWritableMaxSeedCharsSchema,
} from './replaySeedBudget.js';

describe('Replay seed budget bounds', () => {
  it('states the measured writer floor and the shared ceiling once', () => {
    expect(HAPPIER_REPLAY_SEED_MIN_CHARS).toBe(1_024);
    expect(HAPPIER_REPLAY_SEED_MAX_CHARS).toBe(200_000);
  });

  // The whole defect in one assertion: 1023 is the largest budget that cannot
  // carry a seed, and no writer may produce it.
  it('refuses a writable budget one character below the floor', () => {
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_SEED_MIN_CHARS - 1).success).toBe(false);
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_SEED_MIN_CHARS).success).toBe(true);
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_SEED_MAX_CHARS).success).toBe(true);
    expect(HappierReplayWritableMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_SEED_MAX_CHARS + 1).success).toBe(false);
  });

  // A released client clamps against its own older floor of 500 before sending,
  // so a reader that rejected those requests would break a shipped contract.
  // The builder owns its contract at every budget in this range.
  it('keeps accepting released-client wire budgets below the writer floor', () => {
    expect(HappierReplayWireMaxSeedCharsSchema.safeParse(500).success).toBe(true);
    expect(HappierReplayWireMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_SEED_ACCEPTED_MIN_CHARS).success).toBe(true);
    expect(HappierReplayWireMaxSeedCharsSchema.safeParse(HAPPIER_REPLAY_SEED_ACCEPTED_MIN_CHARS - 1).success).toBe(false);
  });

  it('bounds the recent-messages window at the one window every owner uses', () => {
    expect(HAPPIER_REPLAY_RECENT_MESSAGES_MAX_COUNT).toBe(500);
    expect(HappierReplayRecentMessagesCountSchema.safeParse(500).success).toBe(true);
    expect(HappierReplayRecentMessagesCountSchema.safeParse(501).success).toBe(false);
    expect(HappierReplayRecentMessagesCountSchema.safeParse(0).success).toBe(false);
  });
});

describe('Replay budget owners derive from the one bound', () => {
  // Storing a below-floor budget used to be accepted verbatim, which is how a
  // user reached "no seed at all, silently". The catalog now recovers to its
  // default instead of retaining a number that cannot work.
  it('does not retain a stored budget below the floor', () => {
    expect(accountSettingsParse({ sessionReplayMaxSeedChars: 500 } as never).sessionReplayMaxSeedChars)
      .toBe(accountSettingsParse({} as never).sessionReplayMaxSeedChars);
    expect(accountSettingsParse({ sessionReplayMaxSeedChars: HAPPIER_REPLAY_SEED_MIN_CHARS } as never).sessionReplayMaxSeedChars)
      .toBe(HAPPIER_REPLAY_SEED_MIN_CHARS);
  });

  it('does not retain a stored budget above the ceiling every other owner enforces', () => {
    expect(accountSettingsParse({ sessionReplayMaxSeedChars: 512 * 1024 } as never).sessionReplayMaxSeedChars)
      .toBe(accountSettingsParse({} as never).sessionReplayMaxSeedChars);
  });

  it('does not retain a stored recent-messages count beyond the resolver window', () => {
    expect(accountSettingsParse({ sessionReplayRecentMessagesCount: 10_000 } as never).sessionReplayRecentMessagesCount)
      .toBe(accountSettingsParse({} as never).sessionReplayRecentMessagesCount);
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
