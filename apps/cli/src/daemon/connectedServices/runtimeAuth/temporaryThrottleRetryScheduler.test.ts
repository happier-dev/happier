import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceTemporaryThrottleRetryScheduler } from './temporaryThrottleRetryScheduler';

function createMemoryStore() {
  const persisted = new Map<string, unknown>();
  return {
    persisted,
    store: {
      read: (sessionId: string) => persisted.get(sessionId) ?? null,
      readAll: () => [...persisted.entries()],
      write: (sessionId: string, intent: unknown) => {
        persisted.set(sessionId, intent);
      },
      remove: (sessionId: string) => {
        persisted.delete(sessionId);
      },
    },
  };
}

describe('ConnectedServiceTemporaryThrottleRetryScheduler', () => {
  it('returns typed unsupported when no durable store is configured', async () => {
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => 1_000,
      store: null,
      resume: async () => ({ status: 'continued' }),
    });

    await expect(scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    })).resolves.toEqual({
      status: 'unsupported',
      nextRetryAtMs: null,
      attemptCount: 0,
      maxAttempts: 0,
    });
    expect(scheduler.read('sess-1')).toBeNull();
  });

  it('schedules a daemon-lifetime retry at resetAtMs and resumes on timer wake', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const resume = vi.fn(async () => ({ status: 'continued' as const }));
      const { store } = createMemoryStore();
      const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
        nowMs: () => Date.now(),
        store,
        resume,
      });

      await expect(scheduler.enable({
        sessionId: 'sess-1',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
        retryAfterMs: 60_000,
        resetAtMs: 3_000,
      })).resolves.toMatchObject({
        status: 'waiting',
        nextRetryAtMs: 3_000,
        attemptCount: 0,
        maxAttempts: 3,
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(scheduler.read('sess-1')).toMatchObject({
        status: 'cancelled',
        nextRetryAtMs: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reschedules when the session resume callback fails', async () => {
    let nowMs = 1_000;
    const resume = vi.fn(async () => {
      throw new Error('respawn failed');
    });
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      maxAttempts: 2,
      resume,
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: null,
      resetAtMs: null,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('sess-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: 'respawn failed',
    });
  });

  it('coalesces repeated reports for the same session without resetting attempts', async () => {
    let nowMs = 1_000;
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async (): Promise<{ status: 'continued' }> => {
        throw new Error('still throttled');
      },
      maxAttempts: 3,
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    });

    nowMs = 2_000;
    await scheduler.wake({ sessionId: 'sess-1', reason: 'manual' });
    expect(scheduler.read('sess-1')).toMatchObject({
      attemptCount: 1,
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 60_000,
      resetAtMs: null,
    });

    expect(scheduler.read('sess-1')).toMatchObject({
      attemptCount: 1,
      maxAttempts: 3,
    });
  });

  it('starts a fresh retry when the reported temporary throttle fingerprint changes', async () => {
    let nowMs = 1_000;
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async (): Promise<{ status: 'continued' }> => {
        throw new Error('still throttled');
      },
      maxAttempts: 3,
    });

    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    });

    nowMs = 2_000;
    await scheduler.wake({ sessionId: 'sess-1', reason: 'manual' });
    expect(scheduler.read('sess-1')).toMatchObject({
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      attemptCount: 1,
    });

    nowMs = 2_500;
    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'secondary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:secondary',
      retryAfterMs: 500,
      resetAtMs: null,
    });

    expect(scheduler.read('sess-1')).toMatchObject({
      serviceId: 'openai-codex',
      profileId: 'secondary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:secondary',
      attemptCount: 0,
      nextRetryAtMs: 3_000,
    });
  });

  it('hydrates waiting retries from a durable store after daemon restart', async () => {
    let nowMs = 1_000;
    const { persisted, store } = createMemoryStore();

    const first = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async () => ({ status: 'continued' }),
    });

    await first.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 1_000,
      resetAtMs: null,
    });

    expect(persisted.get('sess-1')).toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 2_000,
    });

    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    nowMs = 2_000;
    const second = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume,
    });

    expect(second.hydrate()).toHaveLength(1);
    await expect(second.wake({ sessionId: 'sess-1', reason: 'manual' })).resolves.toEqual({ status: 'resumed' });
    expect(resume).toHaveBeenCalledOnce();
    expect(persisted.get('sess-1')).toMatchObject({
      status: 'cancelled',
      nextRetryAtMs: null,
    });
  });

  it('keeps duplicate reports for one interrupted turn deduplicated but rearms a later turn', async () => {
    let nowMs = 1_000;
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => nowMs,
      store,
      resume: async () => ({ status: 'continued' }),
    });
    const base = {
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 60_000,
      resetAtMs: null,
    } as const;
    const firstContinuation = {
      interruptedOriginId: 'turn-1',
      resumePromptMode: 'standard' as const,
      customResumePrompt: null,
      recoveryKind: 'temporary_throttle' as const,
    };
    await scheduler.enable({ ...base, continuation: firstContinuation });
    await scheduler.cancel({ sessionId: 'sess-1' });

    await expect(scheduler.enable({ ...base, continuation: firstContinuation })).resolves.toMatchObject({
      status: 'cancelled',
    });

    nowMs = 2_000;
    await expect(scheduler.enable({
      ...base,
      continuation: { ...firstContinuation, interruptedOriginId: 'turn-2' },
    })).resolves.toMatchObject({ status: 'waiting', attemptCount: 0 });
    expect(scheduler.read('sess-1')).toMatchObject({
      continuation: { interruptedOriginId: 'turn-2' },
    });
  });

  it('removes a recovery superseded by newer user input', async () => {
    const { store } = createMemoryStore();
    const scheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => 1_000,
      store,
      resume: async () => ({ status: 'superseded', reason: 'newer_user_input' }),
    });
    await scheduler.enable({
      sessionId: 'sess-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      issueFingerprint: 'temporary-throttle:openai-codex:main:primary',
      retryAfterMs: 0,
      resetAtMs: null,
      continuation: {
        interruptedOriginId: 'turn-1',
        resumePromptMode: 'standard',
        customResumePrompt: null,
        recoveryKind: 'temporary_throttle',
      },
    });

    await expect(scheduler.wake({ sessionId: 'sess-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'superseded' });
    expect(scheduler.read('sess-1')).toBeNull();
  });
});
