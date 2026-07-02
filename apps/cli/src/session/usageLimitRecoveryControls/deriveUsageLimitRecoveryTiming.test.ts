import { describe, expect, it } from 'vitest';

async function loadDeriveUsageLimitRecoveryTiming() {
  const modulePath = './deriveUsageLimitRecoveryTiming';
  const loaded = await import(modulePath).catch(() => null);
  expect(loaded).not.toBeNull();
  return loaded as Readonly<{
    deriveUsageLimitRecoveryTiming: (input: Readonly<{
      occurredAtMs: number | null | undefined;
      resetAtMs: number | null | undefined;
      retryAfterMs: number | null | undefined;
    }>) => Readonly<{ resetAtMs: number | null; nextCheckAtMs: number | null }>;
  }>;
}

describe('deriveUsageLimitRecoveryTiming', () => {
  it('uses an explicit reset timestamp as the next check time', async () => {
    const { deriveUsageLimitRecoveryTiming } = await loadDeriveUsageLimitRecoveryTiming();

    expect(deriveUsageLimitRecoveryTiming({
      occurredAtMs: 1_000,
      resetAtMs: 5_000,
      retryAfterMs: 2_000,
    })).toEqual({
      resetAtMs: 5_000,
      nextCheckAtMs: 5_000,
    });
  });

  it('derives the next check time from retry-after timing when reset timestamp is absent', async () => {
    const { deriveUsageLimitRecoveryTiming } = await loadDeriveUsageLimitRecoveryTiming();

    expect(deriveUsageLimitRecoveryTiming({
      occurredAtMs: 1_000,
      resetAtMs: null,
      retryAfterMs: 2_500,
    })).toEqual({
      resetAtMs: null,
      nextCheckAtMs: 3_500,
    });
  });

  it('keeps the next check time null when no timing is available', async () => {
    const { deriveUsageLimitRecoveryTiming } = await loadDeriveUsageLimitRecoveryTiming();

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
