import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server: session runner restarts', () => {
  it('preserves a typed incomplete physical stop outcome at the local control boundary', async () => {
    const stopSession = vi.fn(async () => ({
      status: 'incomplete' as const,
      reason: 'runner_exit_timeout' as const,
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession,
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/stop-session',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: 'sess-1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'incomplete', reason: 'runner_exit_timeout' });
      expect(stopSession).toHaveBeenCalledWith('sess-1');
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated restart requests', async () => {
    const handleSessionRunnerRestart = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart',
        payload: {
          sessionId: 'sess-1',
          reason: 'daemon_restart_session_runners_command',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(handleSessionRunnerRestart).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('validates and forwards single-session restart requests', async () => {
    const handleSessionRunnerRestart = vi.fn(async () => ({
      ok: true as const,
      status: 'dry_run_restartable' as const,
      sessionId: 'sess-1',
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestart,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          sessionId: 'sess-1',
          mode: 'if_stale',
          dryRun: true,
          reason: 'daemon_restart_session_runners_command',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        status: 'dry_run_restartable',
        sessionId: 'sess-1',
      });
      expect(handleSessionRunnerRestart).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        mode: 'if_stale',
        dryRun: true,
        reason: 'daemon_restart_session_runners_command',
      });
    } finally {
      await app.close();
    }
  });

  it('threads bulk dry-run requests to the daemon handler without signalling runners at the endpoint layer', async () => {
    const handleSessionRunnerRestartAll = vi.fn(async () => ({
      ok: false as const,
      mode: 'force_current_cli' as const,
      requestedCount: 1,
      restartedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      results: [{
        ok: true as const,
        status: 'dry_run_restartable' as const,
        sessionId: 'sess-1',
      }],
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerRestartAll,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/restart-all',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: {
          mode: 'force_current_cli',
          dryRun: true,
          reason: 'daemon_restart_session_runners_command',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(handleSessionRunnerRestartAll).toHaveBeenCalledWith({
        mode: 'force_current_cli',
        dryRun: true,
        reason: 'daemon_restart_session_runners_command',
      });
      expect(res.json().results[0].status).toBe('dry_run_restartable');
    } finally {
      await app.close();
    }
  });

  it('validates and forwards session-runner status requests', async () => {
    const handleSessionRunnerStatusGet = vi.fn(async () => ({
      v: 1 as const,
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
        entrypointSource: 'unknown' as const,
        startedBy: 'unknown' as const,
        startingMode: 'unknown' as const,
      },
      daemon: {
        cliVersion: null,
        startedWithCliVersion: null,
        currentEntrypointVersion: null,
        currentEntrypointSource: 'unknown' as const,
      },
      versionState: 'unknown' as const,
      statusSource: 'unknown' as const,
      plannedRestart: {
        supported: false,
        eligible: false,
        disabledReason: 'no_tracked_process' as const,
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'sess-1' }),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionRunnerStatusGet,
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/session-runners/status',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { sessionId: ' sess-1 ' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        v: 1,
        sessionId: 'sess-1',
        versionState: 'unknown',
      });
      expect(handleSessionRunnerStatusGet).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    } finally {
      await app.close();
    }
  });
});
