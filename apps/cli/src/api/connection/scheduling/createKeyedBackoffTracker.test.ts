import { describe, expect, it } from 'vitest';

describe('createKeyedBackoffTracker', () => {
  it('tracks exponential per-key retry delay and clears it on success', async () => {
    let now = 1_000;
    const mod = await import('./createKeyedBackoffTracker').catch(() => null);
    expect(mod?.createKeyedBackoffTracker).toBeTypeOf('function');
    if (!mod) return;

    const tracker = mod.createKeyedBackoffTracker({
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
      now: () => now,
    });

    expect(tracker.recordFailure('quota:work')).toMatchObject({ attempt: 1, delayMs: 100, retryAtMs: 1_100 });
    now = 1_050;
    expect(tracker.getDelayMs('quota:work')).toBe(50);
    now = 1_100;
    expect(tracker.recordFailure('quota:work')).toMatchObject({ attempt: 2, delayMs: 200, retryAtMs: 1_300 });
    tracker.recordSuccess('quota:work');
    expect(tracker.getState('quota:work')).toBeNull();
  });

  it('honors retry-after as a delay floor', async () => {
    const mod = await import('./createKeyedBackoffTracker').catch(() => null);
    expect(mod?.createKeyedBackoffTracker).toBeTypeOf('function');
    if (!mod) return;

    const tracker = mod.createKeyedBackoffTracker({
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
      now: () => 1_000,
    });

    expect(tracker.recordFailure('quota:work', { retryAfterMs: 500 })).toMatchObject({
      attempt: 1,
      delayMs: 500,
      retryAtMs: 1_500,
    });
  });
});
