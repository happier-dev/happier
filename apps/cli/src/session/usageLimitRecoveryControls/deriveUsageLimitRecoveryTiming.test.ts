import { describe, expect, it } from 'vitest';

import { deriveUsageLimitRecoveryTiming } from './deriveUsageLimitRecoveryTiming';

describe('deriveUsageLimitRecoveryTiming', () => {
  it('uses an explicit reset timestamp as the next check time', () => {
    expect(deriveUsageLimitRecoveryTiming({
      occurredAtMs: 1_000,
      resetAtMs: 5_000,
      retryAfterMs: 2_000,
    })).toEqual({
      resetAtMs: 5_000,
      nextCheckAtMs: 5_000,
    });
  });

  it('derives the next check time from retry-after timing when reset timestamp is absent', () => {
    expect(deriveUsageLimitRecoveryTiming({
      occurredAtMs: 1_000,
      resetAtMs: null,
      retryAfterMs: 2_500,
    })).toEqual({
      resetAtMs: null,
      nextCheckAtMs: 3_500,
    });
  });

  it('does not infer recovery while another exhausted window has no reset time', () => {
    expect(deriveUsageLimitRecoveryTiming({
      occurredAtMs: 1_000, resetAtMs: 5_000, retryAfterMs: null,
      windows: [{ remainingPct: 0, resetAtMs: 5_000 }, { remainingPct: 0, resetAtMs: null }],
    })).toEqual({ resetAtMs: null, nextCheckAtMs: null });
  });

  it('keeps the next check time null when no timing is available', () => {
    expect(deriveUsageLimitRecoveryTiming({
      occurredAtMs: 1_000,
      resetAtMs: null,
      retryAfterMs: null,
    })).toEqual({
      resetAtMs: null,
      nextCheckAtMs: null,
    });
  });
});
