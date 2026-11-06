import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RestartAllSessionRunnersResultV1, SessionRunnerRuntimeStateV1 } from '@happier-dev/protocol';

import { createDaemonControlApp, startDaemonControlServer } from './controlServer';

function createBaseControlApp(overrides: Partial<Parameters<typeof createDaemonControlApp>[0]> = {}) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine_local',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: 'test-token',
    ...overrides,
  });
}

describe('daemon control server: session runner planned restart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves a typed incomplete physical stop outcome at the local control boundary', async () => {
    const stopSession = vi.fn(async () => ({
      status: 'incomplete' as const,
      reason: 'runner_exit_timeout' as const,
    }));
    const app = createBaseControlApp({ stopSession });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/stop-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ sessionId: 'sess_1' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'incomplete', reason: 'runner_exit_timeout' });
      expect(stopSession).toHaveBeenCalledWith('sess_1', { source: undefined, transport: 'local_http' });
    } finally {
      await app.close();
    }
  });

  it('requires the daemon control token for bulk planned restarts', async () => {
    const handleSessionRunnerRestartAll = vi.fn(async (): Promise<RestartAllSessionRunnersResultV1> => ({
      ok: true,
      mode: 'force_current_cli',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));
    const app = createBaseControlApp({ handleSessionRunnerRestartAll } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: false,
          reason: 'daemon_restart_session_runners',
        }),
      });

      expect(response.statusCode).toBe(401);
      expect(handleSessionRunnerRestartAll).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects malformed bulk planned restart requests before calling the handler', async () => {
    const handleSessionRunnerRestartAll = vi.fn(async (): Promise<RestartAllSessionRunnersResultV1> => ({
      ok: true,
      mode: 'force_current_cli',
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));
    const app = createBaseControlApp({ handleSessionRunnerRestartAll } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: false,
          reason: 'not_a_protocol_reason',
        }),
      });

      expect(response.statusCode).toBe(400);
      expect(handleSessionRunnerRestartAll).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns protocol bulk results with restarted, skipped, and failed session mappings intact', async () => {
    const result: RestartAllSessionRunnersResultV1 = {
      ok: false,
      mode: 'force_current_cli',
      requestedCount: 3,
      restartedCount: 1,
      skippedCount: 1,
      failedCount: 1,
      results: [
        { ok: true, status: 'restarted', sessionId: 'sess_1' },
        {
          ok: false,
          status: 'version_unknown',
          sessionId: 'sess_2',
          reasonCode: 'current_entrypoint_unknown',
        },
        {
          ok: false,
          status: 'spawn_failed',
          sessionId: 'sess_3',
          diagnostics: { error: 'spawn failed' },
        },
      ],
    };
    const handleSessionRunnerRestartAll = vi.fn(async () => result);
    const app = createBaseControlApp({ handleSessionRunnerRestartAll } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          mode: 'force_current_cli',
          dryRun: true,
          reason: 'daemon_restart_session_runners',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(handleSessionRunnerRestartAll).toHaveBeenCalledWith({
        mode: 'force_current_cli',
        dryRun: true,
        reason: 'daemon_restart_session_runners',
      });
      expect(response.json()).toEqual(result);
    } finally {
      await app.close();
    }
  });

  it('forwards authenticated session runner status requests to the handler', async () => {
    const result: SessionRunnerRuntimeStateV1 = {
      v: 1,
      sessionId: 'sess_1',
      machineId: 'machine_local',
      daemonId: 'daemon_1',
      observedAtMs: 123,
      runner: {
        pid: 1234,
        runtimeId: 'version:1.0.0',
        cliVersion: '1.0.0',
        entrypointVersion: '1.0.0',
        processCommandHash: 'hash-1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'version:1.1.0',
        currentEntrypointSource: 'launch_spec',
      },
      versionState: 'stale',
      statusSource: 'process_command_inferred',
      plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
      },
    };
    const handleSessionRunnerStatusGet = vi.fn(async () => result);
    const app = createBaseControlApp({ handleSessionRunnerStatusGet } as Partial<Parameters<typeof createDaemonControlApp>[0]>);

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/session-runners/status',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ sessionId: ' sess_1 ' }),
      });

      expect(response.statusCode).toBe(200);
      expect(handleSessionRunnerStatusGet).toHaveBeenCalledWith({ sessionId: 'sess_1' });
      expect(response.json()).toEqual(result);
    } finally {
      await app.close();
    }
  });

  it('wires session runner status requests through the production control server wrapper', async () => {
    const result: SessionRunnerRuntimeStateV1 = {
      v: 1,
      sessionId: 'sess_1',
      machineId: 'machine_local',
      daemonId: 'daemon_1',
      observedAtMs: 123,
      runner: {
        pid: 1234,
        runtimeId: 'version:1.0.0',
        cliVersion: '1.0.0',
        entrypointVersion: '1.0.0',
        processCommandHash: 'hash-1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'version:1.1.0',
        currentEntrypointSource: 'launch_spec',
      },
      versionState: 'stale',
      statusSource: 'process_command_inferred',
      plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
      },
    };
    const handleSessionRunnerStatusGet = vi.fn(async () => result);
    const server = await startDaemonControlServer({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerStatusGet,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/session-runners/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        body: JSON.stringify({ sessionId: ' sess_1 ' }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(result);
      expect(handleSessionRunnerStatusGet).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    } finally {
      await server.stop();
    }
  });
});
