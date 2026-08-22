import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<unknown>;

const { getDaemonSessionRunnerStatusMock, getDaemonSessionRunnerStatusV2Mock, requestDaemonSessionRunnerRestartMock, requestDaemonSessionRunnerRestartV2Mock, restartAllDaemonSessionRunnersMock } = vi.hoisted(() => ({
  getDaemonSessionRunnerStatusMock: vi.fn(),
  getDaemonSessionRunnerStatusV2Mock: vi.fn(),
  requestDaemonSessionRunnerRestartMock: vi.fn(),
  requestDaemonSessionRunnerRestartV2Mock: vi.fn(),
  restartAllDaemonSessionRunnersMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    getDaemonSessionRunnerStatus: getDaemonSessionRunnerStatusMock,
    getDaemonSessionRunnerStatusV2: getDaemonSessionRunnerStatusV2Mock,
    requestDaemonSessionRunnerRestart: requestDaemonSessionRunnerRestartMock,
    requestDaemonSessionRunnerRestartV2: requestDaemonSessionRunnerRestartV2Mock,
    restartAllDaemonSessionRunners: restartAllDaemonSessionRunnersMock,
  };
});

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

function registerHandlers(): Map<string, Handler> {
  const mgr = createRpcHandlerManager();
  registerMachineRpcHandlers({
    rpcHandlerManager: mgr as any,
    handlers: {
      spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
      stopSession: async () => true,
      requestShutdown: () => {},
    },
  });
  return mgr.handlers;
}

describe('rpcHandlers (session runner restarts)', () => {
  beforeEach(() => {
    getDaemonSessionRunnerStatusMock.mockReset();
    getDaemonSessionRunnerStatusV2Mock.mockReset();
    requestDaemonSessionRunnerRestartMock.mockReset();
    requestDaemonSessionRunnerRestartV2Mock.mockReset();
    restartAllDaemonSessionRunnersMock.mockReset();
  });

  it('validates and forwards session-runner status RPC requests', async () => {
    getDaemonSessionRunnerStatusMock.mockResolvedValueOnce({
      v: 1,
      sessionId: 'sess-1',
      machineId: null,
      daemonId: null,
      observedAtMs: 100,
      runner: {
        pid: null,
        runtimeId: null,
        cliVersion: null,
        entrypointVersion: null,
        processCommandHash: null,
        entrypointSource: 'unknown',
        startedBy: 'unknown',
        startingMode: 'unknown',
      },
      daemon: {
        cliVersion: null,
        startedWithCliVersion: null,
        currentEntrypointVersion: null,
        currentEntrypointSource: 'unknown',
      },
      versionState: 'unknown',
      statusSource: 'unknown',
      plannedRestart: {
        supported: false,
        eligible: false,
        disabledReason: 'no_tracked_process',
      },
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET);
    expect(handler).toBeDefined();

    await expect(handler!({ sessionId: ' sess-1 ' })).resolves.toMatchObject({
      v: 1,
      sessionId: 'sess-1',
      versionState: 'unknown',
    });

    expect(getDaemonSessionRunnerStatusMock).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('validates and forwards additive V2 status witness RPC requests', async () => {
    getDaemonSessionRunnerStatusV2Mock.mockResolvedValueOnce({
      v: 2,
      state: {
        v: 1,
        sessionId: 'sess-1',
        machineId: null,
        daemonId: null,
        observedAtMs: 100,
        runner: {
          pid: 123,
          runtimeId: null,
          cliVersion: null,
          entrypointVersion: null,
          processCommandHash: null,
          entrypointSource: 'unknown',
          startedBy: 'unknown',
          startingMode: 'unknown',
        },
        daemon: {
          cliVersion: null,
          startedWithCliVersion: null,
          currentEntrypointVersion: null,
          currentEntrypointSource: 'unknown',
        },
        versionState: 'unknown',
        statusSource: 'unknown',
        plannedRestart: {
          supported: false,
          eligible: false,
          disabledReason: 'no_tracked_process',
        },
      },
      runnerProcessIdentity: {
        pid: 456,
        processStartTimeMs: 1_000,
      },
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET);
    expect(handler).toBeDefined();

    await expect(handler!({ sessionId: ' sess-1 ' })).resolves.toMatchObject({
      v: 2,
      runnerProcessIdentity: { pid: 456, processStartTimeMs: 1_000 },
    });
    expect(getDaemonSessionRunnerStatusV2Mock).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('validates and forwards single session-runner restart RPC requests', async () => {
    requestDaemonSessionRunnerRestartMock.mockResolvedValueOnce({
      ok: true,
      status: 'dry_run_restartable',
      sessionId: 'sess-1',
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    await expect(handler!({
      sessionId: ' sess-1 ',
      mode: 'force_current_cli',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).resolves.toEqual({
      ok: true,
      status: 'dry_run_restartable',
      sessionId: 'sess-1',
    });

    expect(requestDaemonSessionRunnerRestartMock).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    });
  });

  it('fails closed for public V1 mutation requests without a process-birth witness', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    await expect(handler!({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'daemon_dist_generation_rollout',
    })).resolves.toEqual({
      ok: false,
      status: 'ineligible',
      sessionId: 'sess-1',
      reasonCode: 'runner_generation_unattested',
    });
    expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
  });

  it('preserves ordinary public V1 explicit restart compatibility', async () => {
    requestDaemonSessionRunnerRestartMock.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 'sess-1',
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);

    await expect(handler!({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
    })).resolves.toMatchObject({ status: 'restarted' });
    expect(requestDaemonSessionRunnerRestartMock).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
    });
  });

  it('validates and forwards process-attested Provider recovery only on restart V2', async () => {
    requestDaemonSessionRunnerRestartV2Mock.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 'sess-1',
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2);
    expect(handler).toBeDefined();
    const request = {
      v: 2,
      sessionId: 'sess-1',
      mode: 'force_current_cli',
      reason: 'provider_binding_change_recovery',
      expectedRunnerPid: 123,
      expectedProcessCommandHash: 'hash-1',
      expectedRunnerEntrypointIdentity: 'runtime-1',
      expectedRunnerProcessIdentity: {
        pid: 123,
        processStartTimeMs: 1_000,
      },
    } as const;

    await expect(handler!(request)).resolves.toMatchObject({ status: 'restarted' });
    expect(requestDaemonSessionRunnerRestartV2Mock).toHaveBeenCalledWith(request);
    expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
  });

  it('rejects malformed single restart RPC requests before calling the daemon client', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART);
    expect(handler).toBeDefined();

    await expect(handler!({
      sessionId: '',
      reason: 'daemon_restart_session_runners_command',
    })).rejects.toThrow();

    expect(requestDaemonSessionRunnerRestartMock).not.toHaveBeenCalled();
  });

  it('validates and forwards bulk session-runner restart RPC requests', async () => {
    restartAllDaemonSessionRunnersMock.mockResolvedValueOnce({
      ok: true,
      mode: 'if_stale',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    });
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL);
    expect(handler).toBeDefined();

    await expect(handler!({
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).resolves.toEqual({
      ok: true,
      mode: 'if_stale',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    });

    expect(restartAllDaemonSessionRunnersMock).toHaveBeenCalledWith({
      mode: 'if_stale',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    });
  });

  it('fails a public bulk rollout restart closed because it has no per-session pending owner', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL);

    await expect(handler!({
      mode: 'force_current_cli',
      reason: 'daemon_dist_generation_rollout',
    })).resolves.toEqual({
      ok: false,
      mode: 'force_current_cli',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    });
    expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
  });

  it('rejects malformed bulk restart RPC requests before calling the daemon client', async () => {
    const handlers = registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL);
    expect(handler).toBeDefined();

    await expect(handler!({
      mode: 'sometimes',
      dryRun: true,
      reason: 'daemon_restart_session_runners_command',
    })).rejects.toThrow();

    expect(restartAllDaemonSessionRunnersMock).not.toHaveBeenCalled();
  });
});
