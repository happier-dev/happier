import { describe, expect, it, vi } from 'vitest';

import { raceWithTimeout } from '@happier-dev/plugin-sdk/experimental/timeout';

import { buildOpenCodeRetryStatusError } from './openCodeRetryStatus.js';
import { createOpenCodeProviderActivityTracker } from './providerActivity/createOpenCodeProviderActivityTracker.js';

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

  it('tracks active provider tool work until terminal evidence arrives', () => {
    const tracker = createOpenCodeProviderActivityTracker();
    tracker.resetForProviderSession('sess-1');

    tracker.observeSessionNextTool({
      sessionId: 'sess-1',
      callId: 'call-1',
      terminal: false,
      source: 'session-next',
    });

    expect(tracker.hasActiveProviderWork()).toBe(true);
    expect(tracker.getProviderWorkState()).toMatchObject({
      active: true,
      activeToolCallCount: 1,
      activeToolCalls: [
        {
          key: 'sess-1:call-1',
          sessionId: 'sess-1',
          callId: 'call-1',
          status: 'running',
          sources: ['session-next'],
        },
      ],
    });

    tracker.observeSessionNextTool({
      sessionId: 'sess-1',
      callId: 'call-1',
      terminal: true,
      source: 'session-next',
    });

    expect(tracker.hasActiveProviderWork()).toBe(false);
    expect(tracker.getActiveSessionIds()).toEqual(['sess-1']);
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
