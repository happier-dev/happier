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

  it('waits for all exhausted windows and any independent blocking reset', () => {
    const input = {
      occurredAtMs: 1_000,
      resetAtMs: 2_000,
      retryAfterMs: null,
      windows: [{ remainingPct: 0, resetAtMs: 3_000 }, { remainingPct: 60, resetAtMs: 9_000 }],
    };
    expect(deriveUsageLimitRecoveryTiming(input)).toEqual({ resetAtMs: 3_000, nextCheckAtMs: 3_000 });
    expect(deriveUsageLimitRecoveryTiming({ ...input, resetAtMs: 4_000 }))
      .toEqual({ resetAtMs: 4_000, nextCheckAtMs: 4_000 });
    expect(deriveUsageLimitRecoveryTiming({ ...input, windows: [...input.windows, { status: 'exhausted' }] }))
      .toEqual({ resetAtMs: null, nextCheckAtMs: null });
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
