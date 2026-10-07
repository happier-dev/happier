import { afterEach, describe, expect, it, vi } from 'vitest';

import { abandonSpawnedSessionBestEffort, abandonSpawnedSessionUntilCompleted } from './awaitSpawnedSessionId';

describe('abandonSpawnedSessionBestEffort', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('retains accepted cleanup observation for the authored duration instead of imposing a one-hour cap', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SPAWN_ABANDON_TIMEOUT_MS', '7200000');
    let resolveStartup!: (result: { status: 'success'; sessionId: string }) => void;
    const startup = new Promise<{ status: 'success'; sessionId: string }>((resolve) => { resolveStartup = resolve; });
    const stopSession = vi.fn(async () => true);
    const archiveSession = vi.fn(async () => {});
    abandonSpawnedSessionBestEffort({
      spawnNonce: 'accepted-cleanup', reason: 'caller cancelled',
      resolveSpawnSessionByNonce: () => startup, stopSession, archiveSession,
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
    expect(stopSession).not.toHaveBeenCalled();
    resolveStartup({ status: 'success', sessionId: 'late-session' });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopSession).toHaveBeenCalledWith('late-session');
    expect(archiveSession).toHaveBeenCalledWith('late-session');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('abandonSpawnedSessionUntilCompleted', () => {
  it('reports completed only after positive canonical cleanup', async () => {
    const archiveSession = vi.fn(async () => true);
    await expect(abandonSpawnedSessionUntilCompleted({
      spawnNonce: 'nonce-a',
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-a' }),
      archiveSession,
    })).resolves.toEqual({ status: 'completed', sessionId: 'session-a' });
    expect(archiveSession).toHaveBeenCalledWith('session-a');
  });

  it.each(['pending', 'not_found', 'unsupported'] as const)(
    'retains custody without cleanup when resolution is %s',
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
});
