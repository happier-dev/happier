import { describe, expect, it, vi } from 'vitest';

import { raceWithTimeout } from '@happier-dev/plugin-sdk/async';

import { buildOpenCodeRetryStatusError } from './openCodeRetryStatus.js';

describe('OpenCode server runtime utilities', () => {
  it('classifies retry status next as retry timing without quota reset fields', () => {
    const nowMs = Date.now();
    const error = buildOpenCodeRetryStatusError({
      type: 'retry',
      attempt: 2,
      message: 'The usage limit has been reached',
      next: nowMs + 10_000,
    });

    expect(error).toMatchObject({
      code: 'opencode_session_retry',
      type: 'opencode_session_retry',
      name: 'FreeUsageLimitError',
      metadata: { attempt: 2 },
    });
    expect(error?.nextRetryAtMs).toBe(nowMs + 10_000);
    expect(error?.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(error?.retryAfterMs).toBeLessThanOrEqual(10_000);
    expect((error as typeof error & { resetAt?: unknown; resetsAt?: unknown })?.resetAt).toBeUndefined();
    expect((error as typeof error & { resetAt?: unknown; resetsAt?: unknown })?.resetsAt).toBeUndefined();
  });

  it('returns timeout without waiting for the underlying promise to settle', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string>(() => undefined);
      const outcomePromise = raceWithTimeout(never, 25);

      await vi.advanceTimersByTimeAsync(25);

      await expect(outcomePromise).resolves.toEqual({ type: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
