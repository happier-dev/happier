import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';

import { createSessionRunnerRespawnManager } from './sessionRunnerRespawn';

describe('createSessionRunnerRespawnManager', () => {
  it('spawns a replacement runner after an unexpected termination', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', agent: 'claude' } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: 'sess-1',
        approvedNewDirectoryCreation: true,
      }),
    );
  });

  it('suppresses respawn when stop was requested', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    manager.markStopRequested('sess-1', { reason: 'daemon_stop_session', requestedAtMs: 1_000 });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', agent: 'claude' } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(0);
  });

  it('retries respawn when spawnSession returns a non-success result', async () => {
    vi.useFakeTimers();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ type: 'error' as const, errorCode: 'SPAWN_FAILED', errorMessage: 'boom' })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-1' });

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', agent: 'claude' } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(2);
  });
});
