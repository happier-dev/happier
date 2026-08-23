import { describe, expect, it, vi } from 'vitest';

import { abandonSpawnedSessionUntilCompleted, awaitSpawnedSessionId } from './awaitSpawnedSessionId';

describe('awaitSpawnedSessionId', () => {
  it('acknowledges cancellation while waiting for daemon custody without stopping the spawned process', async () => {
    const controller = new AbortController();
    const pending = awaitSpawnedSessionId({
      result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-cancel' },
      resolveSpawnSessionByNonce: async () => ({ status: 'pending' }),
      pollIntervalMs: 60_000,
      signal: controller.signal,
    });

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns the session id directly when the spawn result already carries one', async () => {
    const result = await awaitSpawnedSessionId({
      result: { type: 'success', sessionId: 'sess_direct' },
    });
    expect(result).toEqual({ type: 'success', sessionId: 'sess_direct' });
  });

  it('passes spawn errors through unchanged', async () => {
    const result = await awaitSpawnedSessionId({
      result: { type: 'error', errorCode: 'SPAWN_FAILED' as never, errorMessage: 'boom' },
    });
    expect(result).toEqual({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'boom' });
  });

  it('maps directory-approval requests to an error', async () => {
    const result = await awaitSpawnedSessionId({
      result: { type: 'requestToApproveDirectoryCreation', directory: '/tmp/x' },
    });
    expect(result).toMatchObject({ type: 'error', errorCode: 'INVALID_REQUEST' });
  });

  it('resolves a pending spawn through the nonce resolver', async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'sess_resolved' });
    const result = await awaitSpawnedSessionId({
      result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-1' },
      resolveSpawnSessionByNonce: resolver,
      timeoutMs: 2_000,
      pollIntervalMs: 25,
    });
    expect(result).toEqual({ type: 'success', sessionId: 'sess_resolved' });
    expect(resolver).toHaveBeenCalledWith('nonce-1', expect.any(Number));
  });

  it('times out with SESSION_WEBHOOK_TIMEOUT when the nonce never resolves', async () => {
    const resolver = vi.fn(async () => ({ status: 'pending' as const }));
    const result = await awaitSpawnedSessionId({
      result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-2' },
      resolveSpawnSessionByNonce: resolver,
      timeoutMs: 100,
      pollIntervalMs: 25,
    });
    expect(result).toMatchObject({ type: 'error', errorCode: 'SESSION_WEBHOOK_TIMEOUT' });
  });

  it('keeps a generic pending spawn bounded by the default 90-second deadline', async () => {
    vi.useFakeTimers();
    try {
      const resolver = vi.fn(async () => ({ status: 'pending' as const }));
      const result = awaitSpawnedSessionId({
        result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-generic-timeout' },
        resolveSpawnSessionByNonce: resolver,
        pollIntervalMs: 250,
      });

      await vi.advanceTimersByTimeAsync(90_000);

      await expect(result).resolves.toMatchObject({
        type: 'error',
        errorCode: 'SESSION_WEBHOOK_TIMEOUT',
      });
      expect(resolver).toHaveBeenCalledTimes(360);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a native-owned accepted spawn alive through a long not-found run until terminal nonce evidence arrives', async () => {
    vi.useFakeTimers();
    try {
      let probes = 0;
      const resolver = vi.fn(async () => {
        probes += 1;
        return probes >= 70
          ? { status: 'success' as const, sessionId: 'sess_slow_native' }
          : { status: 'not_found' as const };
      });
      const result = awaitSpawnedSessionId({
        result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-slow-native' },
        resolveSpawnSessionByNonce: resolver,
        timeoutMs: null,
        pollIntervalMs: 250,
      });

      await vi.advanceTimersByTimeAsync(18_000);

      await expect(result).resolves.toEqual({ type: 'success', sessionId: 'sess_slow_native' });
      expect(resolver).toHaveBeenCalledTimes(70);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast when the daemon does not support nonce resolution', async () => {
    const resolver = vi.fn(async () => ({ status: 'unsupported' as const }));
    const result = await awaitSpawnedSessionId({
      result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-3' },
      resolveSpawnSessionByNonce: resolver,
      timeoutMs: 2_000,
      pollIntervalMs: 25,
    });
    expect(result).toMatchObject({ type: 'error', errorCode: 'UNEXPECTED' });
  });

  it('passes a terminal native-owned nonce resolution error through unchanged', async () => {
    const result = await awaitSpawnedSessionId({
      result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-child-exit' },
      resolveSpawnSessionByNonce: async () => ({
        status: 'error',
        errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
        errorMessage: 'Child process exited before session webhook',
      }),
      timeoutMs: null,
      pollIntervalMs: 25,
    });
    expect(result).toEqual({
      type: 'error',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
      errorMessage: 'Child process exited before session webhook',
    });
  });

  it('fails when a pending spawn has no nonce or no resolver to resolve it', async () => {
    const withoutNonce = await awaitSpawnedSessionId({
      result: { type: 'success', sessionIdStatus: 'pending' },
      resolveSpawnSessionByNonce: async () => ({ status: 'pending' as const }),
    });
    expect(withoutNonce).toMatchObject({ type: 'error', errorCode: 'UNEXPECTED' });

    const withoutResolver = await awaitSpawnedSessionId({
      result: { type: 'success', sessionIdStatus: 'pending', spawnNonce: 'nonce-4' },
    });
    expect(withoutResolver).toMatchObject({ type: 'error', errorCode: 'UNEXPECTED' });
  });
});

describe('abandonSpawnedSessionUntilCompleted', () => {
  it('reports completed only after the resolved session is positively stopped and archived', async () => {
    const archiveSession = vi.fn(async () => true);
    await expect(abandonSpawnedSessionUntilCompleted({
      spawnNonce: 'nonce-a',
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-a' }),
      archiveSession,
    })).resolves.toEqual({ status: 'completed', sessionId: 'session-a' });
    expect(archiveSession).toHaveBeenCalledWith('session-a');
  });

  it.each(['pending', 'not_found', 'unsupported'] as const)(
    'does not archive or report completed when resolution is %s',
    async (status) => {
      const archiveSession = vi.fn(async () => true);
      await expect(abandonSpawnedSessionUntilCompleted({
        spawnNonce: 'nonce-a',
        resolveSpawnSessionByNonce: async () => ({ status }),
        archiveSession,
      })).resolves.toEqual({ status });
      expect(archiveSession).not.toHaveBeenCalled();
    },
  );

  it('keeps failed cleanup non-completed', async () => {
    await expect(abandonSpawnedSessionUntilCompleted({
      spawnNonce: 'nonce-a',
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-a' }),
      archiveSession: async () => false,
    })).resolves.toEqual({ status: 'failed' });
  });

  it('maps a terminal resolution error to failed cleanup', async () => {
    const archiveSession = vi.fn(async () => true);
    await expect(abandonSpawnedSessionUntilCompleted({
      spawnNonce: 'nonce-a',
      resolveSpawnSessionByNonce: async () => ({
        status: 'error',
        errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
        errorMessage: 'Child exited',
      }),
      archiveSession,
    })).resolves.toEqual({ status: 'failed' });
    expect(archiveSession).not.toHaveBeenCalled();
  });
});
