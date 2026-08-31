import { describe, expect, it, vi } from 'vitest';

type TemporaryThrottleModule = Readonly<{
  TemporaryThrottleRecoveryScheduler: new (deps: {
    nowMs: () => number;
    jitterMs?: () => number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    retry?: (intent: unknown, context: { sessionId: string }) => Promise<{
      status: 'ready' | 'wait' | 'exhausted';
      retryAfterMs?: number | null;
      lastError?: string | null;
    }>;
    resume?: (intent: unknown) => Promise<
      | { status: 'continued' }
      | { status: 'superseded'; reason: string }
      | { status: 'terminal'; lastError: string }
    >;
    store?: {
      read: (sessionId: string) => unknown | null;
      readAll?: () => ReadonlyArray<readonly [sessionId: string, value: unknown]>;
      write: (sessionId: string, intent: unknown) => Promise<void> | void;
      remove?: (sessionId: string) => Promise<void> | void;
    };
  }) => {
    enable: (input: {
      sessionId: string;
      issueFingerprint: string;
      retryAfterMs?: number | null;
      resetAtMs?: number | null;
      maxAttempts?: number;
      continuation?: {
        interruptedOriginId: string;
        resumePromptMode: 'standard' | 'off' | 'custom';
        customResumePrompt?: string | null;
        recoveryKind: 'temporary_throttle';
      } | null;
    }) => Promise<{ status: string; nextRetryAtMs: number | null; attemptCount: number }>;
    read: (sessionId: string) => { status: string; nextRetryAtMs: number | null; attemptCount: number; issueFingerprint?: string } | null;
    wake: (input: { sessionId: string; reason: 'timer' | 'retry_now' }) => Promise<{ status: string }>;
    retryNow: (input: { sessionId: string }) => Promise<{ status: string }>;
    stopRetrying: (input: { sessionId: string }) => Promise<{ status: string } | null>;
    hydrate: () => ReadonlyArray<unknown>;
    dispose: () => void;
  };
}>;

async function loadTemporaryThrottleModule(): Promise<TemporaryThrottleModule> {
  const modulePath = './TemporaryThrottleRecoveryScheduler';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  expect(typeof (mod as Partial<TemporaryThrottleModule> | null)?.TemporaryThrottleRecoveryScheduler).toBe('function');
  return mod as TemporaryThrottleModule;
}

describe('TemporaryThrottleRecoveryScheduler', () => {
  it('wakes from its own timer and resumes only after a ready probe', async () => {
    vi.useFakeTimers();
    try {
      const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
      let nowMs = 1_000;
      const retry = vi.fn(async () => ({ status: 'ready' as const }));
      const resume = vi.fn(async () => ({ status: 'continued' as const }));
      const scheduler = new TemporaryThrottleRecoveryScheduler({
        nowMs: () => nowMs,
        retry,
        resume,
      });

      await scheduler.enable({
        sessionId: 'session-1',
        issueFingerprint: 'temporary-throttle:codex:1',
        retryAfterMs: 1_000,
      });

      nowMs = 1_999;
      await vi.advanceTimersByTimeAsync(999);
      expect(retry).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();

      nowMs = 2_000;
      await vi.advanceTimersByTimeAsync(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(scheduler.read('session-1')?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers a future reset timestamp over Retry-After and base backoff', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
    });

    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 60_000,
      resetAtMs: 3_000,
    })).resolves.toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextRetryAtMs: 3_000,
    });
  });

  it('hydrates a waiting throttle passively after daemon restart and resumes exactly once on explicit retry', async () => {
    vi.useFakeTimers();
    try {
      const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
      let nowMs = 1_000;
      const written = new Map<string, unknown>();
      const store = {
        read: (sessionId: string) => written.get(sessionId) ?? null,
        readAll: () => [...written.entries()],
        write: (sessionId: string, intent: unknown) => {
          written.set(sessionId, intent);
        },
        remove: (sessionId: string) => {
          written.delete(sessionId);
        },
      };

      const firstScheduler = new TemporaryThrottleRecoveryScheduler({
        nowMs: () => nowMs,
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        store,
      });

      await firstScheduler.enable({
        sessionId: 'session-1',
        issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
        retryAfterMs: 2_000,
        maxAttempts: 3,
      });
      firstScheduler.dispose();

      const retry = vi.fn(async () => ({ status: 'ready' as const }));
      const resume = vi.fn(async () => ({ status: 'continued' as const }));
      const restartedScheduler = new TemporaryThrottleRecoveryScheduler({
        nowMs: () => nowMs,
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        retry,
        resume,
        store,
      });

      expect(restartedScheduler.hydrate()).toHaveLength(1);
      expect(restartedScheduler.read('session-1')).toMatchObject({
        status: 'waiting',
        issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
        attemptCount: 0,
        nextRetryAtMs: 3_000,
      });

      nowMs = 3_000;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(retry).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();

      await expect(restartedScheduler.retryNow({ sessionId: 'session-1' }))
        .resolves.toEqual({ status: 'resumed' });
      expect(retry).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(store.read('session-1')).toMatchObject({
        status: 'cancelled',
        nextRetryAtMs: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses Retry-After before jittered backoff and retries with bounded attempts', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi
      .fn()
      .mockResolvedValueOnce({ status: 'wait' as const, retryAfterMs: null })
      .mockResolvedValueOnce({ status: 'ready' as const });
    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      jitterMs: () => 250,
      retry,
      resume,
    });

    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 4_000,
      maxAttempts: 2,
    })).resolves.toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 5_000,
      attemptCount: 0,
    });

    nowMs = 5_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 7_250,
    });

    nowMs = 7_250;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'resumed' });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('supports retry now and stop retrying controls', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const retry = vi.fn(async () => ({ status: 'wait' as const, retryAfterMs: 10_000 }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 60_000,
    });

    await expect(scheduler.retryNow({ sessionId: 'session-1' })).resolves.toEqual({ status: 'waiting' });
    expect(retry).toHaveBeenCalledTimes(1);
    await expect(scheduler.stopRetrying({ sessionId: 'session-1' })).resolves.toEqual({ status: 'cancelled' });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('does not resurrect a cancelled same-fingerprint throttle report', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 60_000,
    });
    await expect(scheduler.stopRetrying({ sessionId: 'session-1' })).resolves.toEqual({ status: 'cancelled' });

    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 1_000,
    })).resolves.toMatchObject({
      status: 'cancelled',
      nextRetryAtMs: null,
    });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('reschedules bounded retry when a throttle probe fails', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => {
      throw new Error('provider request timed out');
    });
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: null,
      maxAttempts: 2,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: 'temporary_throttle_probe_failed',
    });
  });

  it('honors Retry-After returned by a throttle probe before exponential backoff', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({
      status: 'wait' as const,
      retryAfterMs: 10_000,
      lastError: 'provider_retry_after',
    }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: null,
      maxAttempts: 3,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 12_000,
      lastError: 'provider_retry_after',
    });
  });

  it('reschedules instead of cancelling when resume fails after a ready probe', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async (): Promise<{ status: 'continued' }> => {
      throw new Error('session respawn failed');
    });
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: null,
      maxAttempts: 2,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: 'temporary_throttle_resume_failed',
    });
  });

  it('does not reset bounded retry state when the same temporary throttle is reported again', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({ status: 'wait' as const, retryAfterMs: null }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: null,
      maxAttempts: 3,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
    });

    nowMs = 2_500;
    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 10_000,
      maxAttempts: 3,
    })).resolves.toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
    });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: null,
    });
  });

  it('starts fresh when a different temporary throttle fingerprint is reported for the same session', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({ status: 'wait' as const, retryAfterMs: null }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: null,
      maxAttempts: 3,
    });

    nowMs = 2_000;
    await scheduler.wake({ sessionId: 'session-1', reason: 'timer' });
    expect(scheduler.read('session-1')).toMatchObject({
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      attemptCount: 1,
    });

    nowMs = 2_500;
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-2',
      retryAfterMs: 500,
      maxAttempts: 3,
    });

    expect(scheduler.read('session-1')).toMatchObject({
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-2',
      attemptCount: 0,
      nextRetryAtMs: 3_000,
    });
  });

  it('keeps duplicate reports for one interrupted turn deduplicated but rearms a later turn', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const scheduler = new TemporaryThrottleRecoveryScheduler({ nowMs: () => nowMs });

    const base = {
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 60_000,
    } as const;
    const firstContinuation = {
      interruptedOriginId: 'turn-1',
      resumePromptMode: 'standard' as const,
      recoveryKind: 'temporary_throttle' as const,
    };
    await scheduler.enable({ ...base, continuation: firstContinuation });
    await scheduler.stopRetrying({ sessionId: 'session-1' });

    await expect(scheduler.enable({ ...base, continuation: firstContinuation })).resolves.toMatchObject({
      status: 'cancelled',
    });

    nowMs = 2_000;
    await expect(scheduler.enable({
      ...base,
      continuation: { ...firstContinuation, interruptedOriginId: 'turn-2' },
    })).resolves.toMatchObject({
      status: 'waiting',
      attemptCount: 0,
    });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      continuation: { interruptedOriginId: 'turn-2' },
    });
  });

  it('removes a recovery superseded by newer user input instead of reporting a resume', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
      retry: async () => ({ status: 'ready' as const }),
      resume: async () => ({ status: 'superseded' as const, reason: 'newer_user_input' }),
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 0,
      continuation: {
        interruptedOriginId: 'turn-1',
        resumePromptMode: 'standard',
        recoveryKind: 'temporary_throttle',
      },
    });

    await expect(scheduler.retryNow({ sessionId: 'session-1' })).resolves.toEqual({ status: 'superseded' });
    expect(scheduler.read('session-1')).toBeNull();
  });

});
