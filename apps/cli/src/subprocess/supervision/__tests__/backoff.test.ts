import { describe, expect, it } from 'vitest';

import { computeExponentialBackoffMs, computeRestartDelayMs } from '../backoff';

describe('backoff', () => {
  it('computes exponential backoff with cap', () => {
    expect(computeExponentialBackoffMs({ attempt: 1, baseDelayMs: 100, maxDelayMs: 10_000 })).toBe(100);
    expect(computeExponentialBackoffMs({ attempt: 2, baseDelayMs: 100, maxDelayMs: 10_000 })).toBe(200);
    expect(computeExponentialBackoffMs({ attempt: 3, baseDelayMs: 100, maxDelayMs: 10_000 })).toBe(400);
    expect(computeExponentialBackoffMs({ attempt: 99, baseDelayMs: 100, maxDelayMs: 250 })).toBe(250);
  });

  it('adds deterministic jitter', () => {
    const delay = computeRestartDelayMs({
      attempt: 1,
      baseDelayMs: 100,
      maxDelayMs: 100,
      jitterMs: 10,
      random: () => 1,
    });
    // random=1 yields max jitter (inclusive)
    expect(delay).toBe(111);
  });
});

