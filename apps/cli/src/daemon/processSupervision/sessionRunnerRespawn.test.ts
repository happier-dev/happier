import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';

import { createSessionRunnerRespawnManager } from './sessionRunnerRespawn';

describe('createSessionRunnerRespawnManager', () => {
  it('spawns a replacement runner after an unexpected termination', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'vendor-sess-1' } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: 'sess-1',
        resume: 'vendor-sess-1',
        approvedNewDirectoryCreation: true,
      }),
    );
  });

  it('uses tracked vendorResumeId when spawnOptions has no resume', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-2',
      vendorResumeId: 'vendor-sess-2',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: 'sess-2',
        resume: 'vendor-sess-2',
        approvedNewDirectoryCreation: true,
      }),
    );
  });

  it('drops whitespace-only resume values before respawn', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-3',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: '   ',
      } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.not.objectContaining({ resume: expect.anything() }));
  });

  it('preserves daemon initialPrompt across respawn so startup delivery can recover after a crash', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-initial-prompt',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        initialPrompt: 'Recover this startup prompt after respawn.',
      } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: 'sess-initial-prompt',
        initialPrompt: 'Recover this startup prompt after respawn.',
        approvedNewDirectoryCreation: true,
      }),
    );
  });

  it('does not respawn sessions that were not started by the daemon', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'user-session',
      pid: 111,
      happySessionId: 'sess-user',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
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
      isSessionAlreadyRunning: async () => false,
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
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(0);
  });

  it('resets restart state when a replacement session is already running before the timer fires', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const isSessionAlreadyRunning = vi
      .fn<() => boolean>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(0);

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);

    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledTimes(1);
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
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(2);
  });

  it('retries respawn when the running-session preflight throws', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const isSessionAlreadyRunning = vi
      .fn<() => boolean>()
      .mockRejectedValueOnce(new Error('preflight offline'))
      .mockResolvedValueOnce(false);

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-preflight-retry',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('suppresses respawn when a running-session preflight failure exhausts retries', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const isSessionAlreadyRunning = vi
      .fn<() => boolean>()
      .mockRejectedValueOnce(new Error('preflight offline 1'));
    const logWarn = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn,
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-preflight-exhausted',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);

    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledTimes(0);
    expect(logWarn).toHaveBeenCalledWith(
      '[DAEMON RUN] Session sess-preflight-exhausted crashed; respawn suppressed (max_restarts_exceeded:1)',
    );
  });
});
