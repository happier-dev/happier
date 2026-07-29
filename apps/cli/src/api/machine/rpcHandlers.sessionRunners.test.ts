import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<unknown>;

const { getDaemonSessionRunnerStatusMock, requestDaemonSessionRunnerRestartMock, restartAllDaemonSessionRunnersMock } = vi.hoisted(() => ({
  getDaemonSessionRunnerStatusMock: vi.fn(),
  requestDaemonSessionRunnerRestartMock: vi.fn(),
  restartAllDaemonSessionRunnersMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    getDaemonSessionRunnerStatus: getDaemonSessionRunnerStatusMock,
    requestDaemonSessionRunnerRestart: requestDaemonSessionRunnerRestartMock,
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
    requestDaemonSessionRunnerRestartMock.mockReset();
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
