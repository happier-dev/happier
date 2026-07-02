import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { createSessionRunnerRespawnManager } from './sessionRunnerRespawn';

type RespawnOptionsResolver = (input: Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
}>) => SpawnSessionOptions | Promise<SpawnSessionOptions>;

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

  it('allows the daemon to refresh runtime snapshot state before respawn', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const resolveRespawnOptions = vi.fn<RespawnOptionsResolver>(async ({ defaultOptions }) => ({
      ...defaultOptions,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 40,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'fresh-profile',
          },
        },
      },
    }));
    const managerParams: Parameters<typeof createSessionRunnerRespawnManager>[0] & {
      resolveRespawnOptions: RespawnOptionsResolver;
    } = {
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      resolveRespawnOptions,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    };

    const manager = createSessionRunnerRespawnManager(managerParams);

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-snapshot',
      vendorResumeId: 'vendor-snapshot',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } satisfies SpawnSessionOptions,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(resolveRespawnOptions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-snapshot',
      vendorResumeId: 'vendor-snapshot',
      defaultOptions: expect.objectContaining({
        existingSessionId: 'sess-snapshot',
        resume: 'vendor-snapshot',
      }),
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 40,
      connectedServices: expect.objectContaining({
        bindingsByServiceId: expect.objectContaining({
          'claude-subscription': expect.objectContaining({ profileId: 'fresh-profile' }),
        }),
      }),
    }));
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

  it('forces respawn for connected-service restart requests even when general respawn is disabled', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: false,
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
      happySessionId: 'sess-connected-service-restart',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, resume: 'codex-thread' } as any,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess-connected-service-restart',
      resume: 'codex-thread',
    }));
  });

  it('does not delay connected-service restart requests behind crash-respawn backoff', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
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
      happySessionId: 'sess-connected-service-immediate-restart',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'claude-thread' } as any,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess-connected-service-immediate-restart',
      resume: 'claude-thread',
    }));
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

  it('suppresses respawn retries when spawnSession returns not_authenticated', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn().mockResolvedValue({
      type: 'error' as const,
      errorCode: 'not_authenticated',
      errorMessage: 'expired token',
    });
    const logWarn = vi.fn();

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
      logWarn,
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-stale-auth',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      '[DAEMON RUN] Respawn suppressed for session sess-stale-auth (auth:not_authenticated)',
    );

    await vi.advanceTimersByTimeAsync(150);
    expect(spawnSession).toHaveBeenCalledTimes(1);
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
