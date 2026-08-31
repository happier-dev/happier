import { describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { createSessionRunnerRespawnManager, type SessionRunnerRespawnOptionsResolver } from './sessionRunnerRespawn';

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
      spawnSession: (opts: SpawnSessionOptions) => spawnSession(opts),
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
    const resolveRespawnOptions = vi.fn<SessionRunnerRespawnOptionsResolver>(async ({ defaultOptions }) => ({
      ...defaultOptions,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 40,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'fresh-profile' },
        },
      },
      connectedServicesUpdatedAt: 50,
    }));

    const manager = createSessionRunnerRespawnManager({
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
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-snapshot',
      vendorResumeId: 'vendor-snapshot',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      connectedServicesUpdatedAt: 50,
      connectedServices: expect.objectContaining({
        bindingsByServiceId: expect.objectContaining({
          anthropic: expect.objectContaining({ profileId: 'fresh-profile' }),
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

  it('preserves pending first-input custody and stable identity across respawn', async () => {
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
        pendingFirstInput: {
          text: 'Recover this startup prompt after respawn.',
          localId: 'spawn-first:stable-respawn',
        },
      } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: 'sess-initial-prompt',
        pendingFirstInput: {
          text: 'Recover this startup prompt after respawn.',
          localId: 'spawn-first:stable-respawn',
        },
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

  it('bounds a storm of SUCCESSFUL intended restarts across cycles by the rolling window (RR-2)', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      maxIntendedRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-intended-storm',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'claude-thread' } as any,
    };

    // Two intended restarts, EACH succeeding (state would previously reset on success).
    for (let cycle = 0; cycle < 2; cycle += 1) {
      manager.handleUnexpectedExit(
        tracked,
        { reason: 'process-exited', code: null, signal: 'SIGTERM' },
        { forceRestart: true },
      );
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(spawnSession).toHaveBeenCalledTimes(2);

    // Third intended restart within the window: refused loudly despite the intermediate successes —
    // the exact incident-#1 restart-loop shape (every relaunch "succeeds", then restarts again).
    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-intended-storm',
      reason: 'no_restart',
      detail: 'max_intended_restarts_exceeded:2',
    }));
  });

  it('still respawns a genuine crash after a successful intended restart (crash budget untouched)', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      maxIntendedRestarts: 5,
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
      happySessionId: 'sess-crash-after-intended',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'claude-thread' } as any,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    // A later genuine crash must still respawn on the generic budget.
    manager.handleUnexpectedExit(tracked, { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnSession).toHaveBeenCalledTimes(2);
  });

  it('logs intended connected-service restarts distinctly from respawn retries', async () => {
    vi.useFakeTimers();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ type: 'error' as const, errorCode: 'SPAWN_FAILED' })
      .mockResolvedValueOnce({ type: 'success' as const, pid: 123 });
    const logDebug = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug,
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-connected-service-telemetry',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-thread',
      },
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Respawning runner for session sess-connected-service-telemetry'),
      expect.objectContaining({
        respawnKind: 'connected_service_intended_restart',
        attempt: 1,
      }),
    );
    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining('Respawning runner for session sess-connected-service-telemetry'),
      expect.objectContaining({
        respawnKind: 'respawn_retry',
        attempt: 2,
      }),
    );
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

  it('reports the previous pid after a forced connected-service respawn succeeds', async () => {
    vi.useFakeTimers();
    const spawnResult = { type: 'success' as const, pid: 123 };
    const spawnSession = vi.fn(async (_opts: unknown) => spawnResult);
    const onRespawnSuccess = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 60_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnSuccess,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-connected-service-clear-intent',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-thread',
      } satisfies SpawnSessionOptions,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(onRespawnSuccess).toHaveBeenCalledTimes(1);
    expect(onRespawnSuccess).toHaveBeenCalledWith({
      sessionId: 'sess-connected-service-clear-intent',
      previousPid: 111,
      result: spawnResult,
    });
  });

  it.each([
    {
      name: 'replacement is already running',
      isSessionAlreadyRunning: async () => true,
      spawnResult: null,
      expectedReason: 'already_running',
    },
    {
      name: 'directory approval is required',
      isSessionAlreadyRunning: async () => false,
      spawnResult: { type: 'requestToApproveDirectoryCreation' as const },
      expectedReason: 'directory_approval_required',
    },
    {
      name: 'auth is not available',
      isSessionAlreadyRunning: async () => false,
      spawnResult: {
        type: 'error' as const,
        errorCode: 'not_authenticated',
        errorMessage: 'expired token',
      },
      expectedReason: 'not_authenticated',
    },
  ])('reports terminal respawn suppression when $name', async ({ isSessionAlreadyRunning, spawnResult, expectedReason }) => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => spawnResult);
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts: SpawnSessionOptions) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    } as any);

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-connected-service-terminal',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-thread',
      } satisfies SpawnSessionOptions,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: null, signal: 'SIGTERM' },
      { forceRestart: true },
    );

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(onRespawnTerminal).toHaveBeenCalledTimes(1);
    expect(onRespawnTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-connected-service-terminal',
      previousPid: 111,
      reason: expectedReason,
    });
  });

  it('keeps ordinary unexpected exits suppressed when general respawn is disabled', async () => {
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
      happySessionId: 'sess-ordinary-disabled',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
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

  it('respawns after the stop request is cleared (e.g. on resume)', async () => {
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

    // A user stop sets the flag; an explicit resume must clear it so a LATER genuine crash respawns
    // (otherwise the stale flag silently vetoes the respawn forever — see the exit-143 crash RCA).
    manager.markStopRequested('sess-1', { reason: 'daemon_stop_session', requestedAtMs: 1_000 });
    manager.clearStopRequested('sess-1');

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('respawns on a forced connected-service restart even when stop was requested', async () => {
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

    // A stale stop flag (e.g. from an earlier manual stop that the resume path never cleared) must
    // NOT veto a connected-service-initiated forced restart — otherwise the forced kill leaves the
    // session dead (the exit-143 "crash" RCA).
    manager.markStopRequested('sess-1', { reason: 'daemon_stop_session', requestedAtMs: 1_000 });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
      { forceRestart: true },
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
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

  it('waits for the staged child-exit notification before retrying a pre-webhook replacement exit', async () => {
    vi.useFakeTimers();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage: 'replacement exited before webhook',
      })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-pre-webhook-exit' });

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 3,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked = (pid: number): TrackedSession => ({
      startedBy: 'daemon',
      pid,
      happySessionId: 'sess-pre-webhook-exit',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    // The spawn result and durable child-exit staging describe the same process exit. The result
    // must not independently consume another retry or launch a competing replacement.
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    manager.handleUnexpectedExit(
      tracked(222),
      { reason: 'process-exited-before-webhook', code: 1, signal: null },
    );
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

  it('suppresses respawn retries when spawnSession returns a structured resume-unreachable continuity error', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn().mockResolvedValue({
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_session_state_unavailable_for_resume',
      errorDetail: {
        kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
        continuityErrorCode: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        agentId: 'claude',
        reason: 'no_resumable_session_file',
        uxDiagnostic: {
          code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
          failurePhase: 'continuity',
          source: 'spawn_resume',
          agentId: 'claude',
          retryable: false,
          suggestedActions: [
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
          ],
          diagnostics: {
            reason: 'no_resumable_session_file',
          },
        },
      },
    });
    const logWarn = vi.fn();
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn,
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-resume-missing',
      vendorResumeId: 'vendor-missing',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'connected', profileId: 'work' },
          },
        },
      },
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      '[DAEMON RUN] Respawn suppressed for session sess-resume-missing (resume unreachable)',
    );
    expect(onRespawnTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-resume-missing',
      previousPid: 111,
      reason: 'resume_unreachable',
    });

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
