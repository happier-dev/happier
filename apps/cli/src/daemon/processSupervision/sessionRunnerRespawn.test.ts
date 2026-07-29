import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnectionId } from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';

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

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
    )).toBe('scheduled');

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

  it('terminalizes a required continuation refusal without scheduling a retry', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const onRespawnTerminal = vi.fn();
    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession,
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-continuation-unreachable',
      vendorResumeId: 'provider-thread',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      } as any,
    };

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-exited', code: 78, signal: null },
    )).toBe('terminal');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-continuation-unreachable',
      previousPid: 111,
      reason: 'continuation_unreachable',
    });
  });

  it('suppresses cold resume when startup-instruction effectiveness is unproven', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    const onRespawnTerminal = vi.fn();
    const startupInstructionsSentinel =
      'PRIV-R01 startup instructions must not survive Agent session open';
    const startupInstructionsMarker = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 7,
    };

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
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

    const tracked = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'global-voice-session',
      vendorResumeId: 'codex-thread',
      agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
      spawnOptions: {
        directory: '/repo',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      } satisfies SpawnSessionOptions,
    } satisfies TrackedSession & Readonly<{
      agentSessionStartupInstructionsMarkerV1: typeof startupInstructionsMarker;
    }>;

    expect(tracked).toHaveProperty(
      'agentSessionStartupInstructionsMarkerV1',
      startupInstructionsMarker,
    );
    expect(JSON.stringify(tracked.spawnOptions)).not.toContain(
      startupInstructionsSentinel,
    );
    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
    )).toBe('terminal');

    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'global-voice-session',
      reason: 'startup_instructions_cold_resume_unproven',
    }));
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
      defaultOptions: expect.not.objectContaining({ resume: expect.anything() }),
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

  it('lets an explicit stop veto a pending connected-service forced restart', async () => {
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

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
      { forceRestart: true },
    )).toBe('ignored');
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not let an older resume admission clear a newer stop request', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess-stop-race' }));
    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 112,
      happySessionId: 'sess-stop-race',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    };

    manager.markStopRequested('sess-stop-race', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_000,
    });
    const completeAdmission = manager.prepareFreshExplicitResumeAdmission('sess-stop-race');
    manager.markStopRequested('sess-stop-race', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_001,
    });
    completeAdmission();

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
      { forceRestart: true },
    )).toBe('ignored');
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not respawn when stop is requested while the running-session preflight is pending', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    let resolvePreflight: (alreadyRunning: boolean) => void = () => {
      throw new Error('preflight resolver was not initialized');
    };
    const isSessionAlreadyRunning = vi.fn(async () =>
      new Promise<boolean>((resolve) => {
        resolvePreflight = resolve;
      }),
    );
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning,
      spawnSession: (opts) => spawnSession(opts),
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-stop-during-running-preflight',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(isSessionAlreadyRunning).toHaveBeenCalledTimes(1);

    manager.markStopRequested('sess-stop-during-running-preflight', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_000,
    });
    resolvePreflight(false);
    await vi.runAllTimersAsync();

    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-stop-during-running-preflight',
      reason: 'stop_requested',
    }));
  });

  it('does not respawn when stop is requested while respawn options are resolving', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 123 }));
    let resolveOptions: (options: SpawnSessionOptions) => void = () => {
      throw new Error('respawn options resolver was not initialized');
    };
    const resolveRespawnOptions = vi.fn<RespawnOptionsResolver>(async ({ defaultOptions }) =>
      new Promise<SpawnSessionOptions>((resolve) => {
        resolveOptions = () => resolve(defaultOptions);
      }),
    );
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 2,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession: (opts) => spawnSession(opts),
      resolveRespawnOptions,
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-stop-during-options',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } } as any,
    };

    manager.handleUnexpectedExit(tracked, { reason: 'process-missing', code: null, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(resolveRespawnOptions).toHaveBeenCalledTimes(1);

    manager.markStopRequested('sess-stop-during-options', {
      reason: 'daemon_stop_session',
      requestedAtMs: 1_000,
    });
    resolveOptions({ directory: '/tmp' } as SpawnSessionOptions);
    await vi.runAllTimersAsync();

    expect(spawnSession).not.toHaveBeenCalled();
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-stop-during-options',
      reason: 'stop_requested',
    }));
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

  it('treats resume-not-supported as terminal instead of retrying a permanent refusal', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async () => ({
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      errorMessage: 'Resume is not supported for this Agent',
    }));
    const onRespawnTerminal = vi.fn();

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 10,
      baseDelayMs: 50,
      maxDelayMs: 50,
      jitterMs: 0,
      isSessionAlreadyRunning: async () => false,
      spawnSession,
      onRespawnTerminal,
      random: () => 0,
      logDebug: () => {},
      logWarn: () => {},
    });

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-resume-not-supported',
      spawnOptions: {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      } as any,
    };

    expect(manager.handleUnexpectedExit(
      tracked,
      { reason: 'process-missing', code: null, signal: null },
    )).toBe('scheduled');

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(onRespawnTerminal).toHaveBeenCalledTimes(1);
    expect(onRespawnTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-resume-not-supported',
      previousPid: 111,
      reason: 'resume_not_supported',
    });
  });

  it('counts a pre-webhook child exit once when spawn result precedes staged exit notification', async () => {
    vi.useFakeTimers();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'error' as const,
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage: 'replacement exited before webhook',
      })
      .mockResolvedValueOnce({ type: 'success' as const, sessionId: 'sess-pre-webhook-exit' });
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

    // The real spawn path resolves the error before durable exit staging invokes this notification.
    expect(manager.handleUnexpectedExit(
      tracked(222),
      { reason: 'process-exited-before-webhook', code: null, signal: null },
    )).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(onRespawnTerminal).not.toHaveBeenCalled();
  });

  it('bounds successful respawns whose replacement runners immediately crash', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, sessionId: 'sess-quick-crash' }));
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
      logWarn: () => {},
    });

    const tracked = (pid: number): TrackedSession => ({
      startedBy: 'daemon',
      pid,
      happySessionId: 'sess-quick-crash',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    manager.handleUnexpectedExit(tracked(222), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(2);

    expect(manager.handleUnexpectedExit(
      tracked(333),
      { reason: 'process-exited', code: 1, signal: null },
    )).toBe('terminal');
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(onRespawnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-quick-crash',
      previousPid: 333,
      reason: 'no_restart',
      detail: 'max_restarts_exceeded:2',
    }));
  });

  it('restores the crash budget after a replacement runner remains stable', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, sessionId: 'sess-stable' }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      stabilityWindowMs: 100,
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
      happySessionId: 'sess-stable',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(manager.handleUnexpectedExit(
      tracked(222),
      { reason: 'process-exited', code: 1, signal: null },
    )).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnSession).toHaveBeenCalledTimes(2);
  });

  it('discards retained crash state when stop is requested during the stability window', async () => {
    vi.useFakeTimers();
    const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, sessionId: 'sess-stopped' }));

    const manager = createSessionRunnerRespawnManager({
      enabled: true,
      maxRestarts: 1,
      stabilityWindowMs: 100,
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
      happySessionId: 'sess-stopped',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } as any,
    });

    manager.handleUnexpectedExit(tracked(111), { reason: 'process-exited', code: 1, signal: null });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawnSession).toHaveBeenCalledTimes(1);

    manager.markStopRequested('sess-stopped', { reason: 'daemon_stop_session', requestedAtMs: 1_000 });
    manager.prepareFreshExplicitResumeAdmission('sess-stopped')();
    expect(manager.handleUnexpectedExit(
      tracked(222),
      { reason: 'process-exited', code: 1, signal: null },
    )).toBe('scheduled');
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

describe('createSessionRunnerRespawnManager intended-restart storms (RR-2 cross-cycle)', () => {
  function createTracked(): TrackedSession {
    return {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-storm',
      spawnOptions: { directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, resume: 'vendor-1' } as any,
    } as TrackedSession;
  }

  it('refuses the N+1th SUCCESSFUL intended restart within the window loudly', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 222 }));
      const warns: string[] = [];
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 5,
        maxIntendedRestarts: 2,
        intendedRestartWindowMs: 30 * 60_000,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession: (opts) => spawnSession(opts),
        random: () => 0,
        logDebug: () => {},
        logWarn: (message) => warns.push(message),
      });

      // Two intended (connected-service) restarts; each respawn SUCCEEDS (cycle ends successfully).
      for (let i = 0; i < 2; i += 1) {
        manager.handleUnexpectedExit(createTracked(), { reason: 'connected-service-restart', code: null, signal: null }, { forceRestart: true });
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(spawnSession).toHaveBeenCalledTimes(2);

      // The third intended restart within the window is REFUSED despite the successful cycles.
      manager.handleUnexpectedExit(createTracked(), { reason: 'connected-service-restart', code: null, signal: null }, { forceRestart: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(warns.some((message) => message.includes('max_intended_restarts_exceeded'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires retained intended-restart state when its existing rolling window elapses', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 222 }));
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 2,
        maxIntendedRestarts: 1,
        intendedRestartWindowMs: 100,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession: (opts) => spawnSession(opts),
        random: () => 0,
        logDebug: () => {},
        logWarn: () => {},
      });

      manager.handleUnexpectedExit(
        createTracked(),
        { reason: 'connected-service-restart', code: null, signal: null },
        { forceRestart: true },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(vi.getTimerCount()).toBe(0);
      expect(manager.handleUnexpectedExit(
        createTracked(),
        { reason: 'connected-service-restart', code: null, signal: null },
        { forceRestart: true },
      )).toBe('scheduled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a genuine crash after a successful intended restart still respawns (crash budget untouched)', async () => {
    vi.useFakeTimers();
    try {
      const spawnSession = vi.fn(async (_opts: unknown) => ({ type: 'success' as const, pid: 222 }));
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 2,
        maxIntendedRestarts: 1,
        intendedRestartWindowMs: 30 * 60_000,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession: (opts) => spawnSession(opts),
        random: () => 0,
        logDebug: () => {},
        logWarn: () => {},
      });

      // One successful intended restart consumes the whole intended budget.
      manager.handleUnexpectedExit(createTracked(), { reason: 'connected-service-restart', code: null, signal: null }, { forceRestart: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(1);

      // A genuine crash afterwards still respawns on the untouched crash budget.
      manager.handleUnexpectedExit(createTracked(), { reason: 'process-missing', code: null, signal: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a transient spawn override for exactly the first respawn attempt without mutating durable tracked options', async () => {
    vi.useFakeTimers();
    try {
      const durableSpawnOptions = {
        directory: '/repo',
        resume: 'vendor-1',
      };
      const transientSpawnOptions = {
        ...durableSpawnOptions,
        providerBindingSecurityChangeConfirmationV1: {
          v: 1 as const,
          sessionId: 'sess-1',
          connectionId: 'pc_gateway' as ProviderConnectionId,
          previousBindingSecurityFingerprint: 'binding-security:v1:a',
          nextBindingSecurityFingerprint: 'binding-security:v1:b',
        },
      };
      const tracked: TrackedSession = {
        ...createTracked(),
        spawnOptions: durableSpawnOptions,
      };
      const spawnSession = vi
        .fn()
        .mockResolvedValueOnce({ type: 'error', errorCode: 'first_attempt_failed' })
        .mockResolvedValueOnce({ type: 'success', pid: 222 });
      const manager = createSessionRunnerRespawnManager({
        enabled: true,
        maxRestarts: 3,
        maxIntendedRestarts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        isSessionAlreadyRunning: async () => false,
        spawnSession,
        random: () => 0,
        logDebug: () => {},
        logWarn: () => {},
      });

      manager.handleUnexpectedExit(
        tracked,
        { reason: 'connected-service-restart', code: null, signal: null },
        { forceRestart: true, spawnOptionsOverride: transientSpawnOptions },
      );

      expect(tracked.spawnOptions).toBe(durableSpawnOptions);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(spawnSession.mock.calls[0]?.[0]).toMatchObject({
        providerBindingSecurityChangeConfirmationV1: transientSpawnOptions.providerBindingSecurityChangeConfirmationV1,
      });
      expect(spawnSession.mock.calls[1]?.[0]).not.toHaveProperty('providerBindingSecurityChangeConfirmationV1');
      expect(tracked.spawnOptions).toBe(durableSpawnOptions);
    } finally {
      vi.useRealTimers();
    }
  });
});
