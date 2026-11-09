import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as requestHttp } from 'node:http';
import { accountSettingsParse } from '@happier-dev/protocol';

import { createDaemonControlApp } from './controlServer';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { createStopSession } from './sessions/stopSession';
import { readProcessIdentityByPid } from './processIdentity';
import { waitForTrackedRunnerProcessesExit } from './sessions/waitForTrackedRunnerProcessesExit';
import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('daemon control server: /stop', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['flushed', 'interrupted'] as const)('waits for the actual HTTP response flush or close before shutdown: %s', async delivery => {
    const writeHeld = createDeferred<void>();
    const shutdown = createDeferred<void>();
    const requestShutdown = vi.fn(() => shutdown.resolve());
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown, onHappySessionWebhook: () => {}, controlToken: 'test-token',
    });
    const releaseWrites: Array<() => void> = [];
    app.addHook('onSend', async (_request, reply, payload) => {
      const socket = reply.raw.socket;
      if (!socket?._writev) throw new Error('Expected native HTTP write boundary');
      const write = socket._write.bind(socket);
      const writev = socket._writev.bind(socket);
      // Hold only the OS adapter; Fastify and HTTP completion remain real.
      vi.spyOn(socket, '_write').mockImplementation((...args) => {
        releaseWrites.push(() => write(...args)); writeHeld.resolve();
      });
      socket._writev = (chunks, callback) => {
        releaseWrites.push(() => writev(chunks, callback)); writeHeld.resolve();
      };
      return payload;
    });
    let client: ReturnType<typeof requestHttp> | undefined;
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected HTTP address');
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const delivered = new Promise<void>((resolve, reject) => {
        client = requestHttp({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/stop',
          headers: { 'x-happier-daemon-token': 'test-token' } }, response => {
          response.on('error', reject); response.on('end', resolve); response.resume();
        });
        client.on('error', reject); client.end();
      });
      // The interrupted control deliberately closes this native transport. Keep
      // its rejection observed even when the earlier shutdown assertion fails.
      void delivered.catch(() => undefined);
      await writeHeld.promise;
      await vi.advanceTimersByTimeAsync(51);
      expect(requestShutdown).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      if (delivery === 'interrupted') client?.destroy();
      for (const release of releaseWrites.splice(0)) release();
      if (delivery === 'flushed') await delivered;
      else await delivered.catch(() => undefined);
      await shutdown.promise;
      expect(requestShutdown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers(); vi.restoreAllMocks();
      for (const release of releaseWrites.splice(0)) release();
      client?.destroy();
      await app.close();
    }
  });

  it('marks only an explicit session Stop, not daemon shutdown cleanup', async () => {
    const intents: Array<string | undefined> = [];
    const app = createDaemonControlApp({
      getChildren: () => [{ startedBy: 'daemon', pid: 111, happySessionId: 'sess-1' }],
      machineId: 'machine_local',
      stopSession: async (_sessionId, intent) => { intents.push(intent); return { status: 'stopped' as const }; },
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'happy-test-123' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });
    try {
      await app.ready();
      const explicit = await app.inject({ method: 'POST', url: '/stop-session',
        headers: { 'x-happier-daemon-token': 'test-token' }, payload: { sessionId: 'sess-1' } });
      expect(explicit.statusCode).toBe(200);
      const shutdown = await app.inject({ method: 'POST', url: '/stop',
        headers: { 'x-happier-daemon-token': 'test-token' }, payload: { stopSessions: true } });
      expect(shutdown.statusCode).toBe(200);
      expect(intents).toEqual(['explicit_stop', 'lifecycle_control']);
    } finally { await app.close(); }
  });

  it('finishes an accepted Stop when the caller leaves during child cleanup', async () => {
    const cleanupStarted = createDeferred<void>();
    const releaseCleanup = createDeferred<void>();
    const responseClosed = createDeferred<void>();
    const requestShutdown = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [{ startedBy: 'daemon', pid: 111, happySessionId: 'sess-1' }],
      machineId: 'machine_local',
      stopSession: async () => { cleanupStarted.resolve(); await releaseCleanup.promise; return { status: 'stopped' as const }; },
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown, onHappySessionWebhook: () => {}, controlToken: 'test-token',
    });
    app.addHook('onRequest', async (_request, reply) => { reply.raw.once('close', () => responseClosed.resolve()); });
    let client: ReturnType<typeof requestHttp> | undefined;
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      client = requestHttp(new URL('/stop', address), { method: 'POST', headers: {
        'x-happier-daemon-token': 'test-token', 'content-type': 'application/json',
      } });
      client.on('error', () => undefined);
      client.end(JSON.stringify({ stopSessions: true }));
      await cleanupStarted.promise;
      client.destroy();
      await responseClosed.promise;
      releaseCleanup.resolve();
      await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledOnce());
    } finally {
      releaseCleanup.resolve(); client?.destroy(); await app.close();
    }
  });

  it('defers shutdown until beforeShutdown resolves (when provided)', async () => {
    const calls: string[] = [];
    const barrier = createDeferred<void>();

    const appParams = {
      getChildren: () => [{ startedBy: 'daemon', pid: 111, happySessionId: 'sess-1' }],
      machineId: 'machine_local',
      stopSession: async (sessionId: string) => {
        calls.push(`stop:${sessionId}`);
        return { status: 'stopped' as const };
      },
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' } as const),
      beforeShutdown: async () => {
        calls.push('beforeShutdown');
        await barrier.promise;
        calls.push('beforeShutdownDone');
      },
      requestShutdown: () => {
        calls.push('shutdown');
      },
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    };
    const app = createDaemonControlApp(appParams);

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'stopping' });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(calls).toEqual(['beforeShutdown']);

      barrier.resolve(undefined);

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(calls).toEqual(['beforeShutdown', 'beforeShutdownDone', 'shutdown']);
    } finally {
      await app.close();
    }
  });

  it('revokes Account custody when an accepted stop reaches the daemon lifecycle owner', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'account:a',
    });
    const lifecycle = createDaemonShutdownController();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' } as const),
      requestShutdown: () => lifecycle.requestShutdown('happier-cli'),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });

      expect(response.statusCode).toBe(200);
      await lifecycle.resolvesWhenShutdownRequested;
      expect(getActiveAccountSettingsSnapshot()).toBeNull();
    } finally {
      await app.close();
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('passes authenticated managed-service transfer intent only for an explicit takeover stop', async () => {
    const beforeShutdown = vi.fn(async () => undefined);
    const requestShutdown = vi.fn();
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      beforeShutdown,
      requestShutdown,
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: {
          'Content-Type': 'application/json',
          'x-happier-daemon-token': 'test-token',
        },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(200);

      await vi.waitFor(() => expect(beforeShutdown).toHaveBeenCalledOnce());
      expect(requestShutdown).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('quiesces session spawn routes before the shutdown drain finishes', async () => {
    const barrier = createDeferred<void>();
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'should-not-spawn' } as const));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'stopped' as const }),
      spawnSession,
      beforeShutdown: async () => {
        await barrier.promise;
      },
      requestShutdown: vi.fn(),
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const stopResponse = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });
      expect(stopResponse.statusCode).toBe(200);

      const spawnResponse = await app.inject({
        method: 'POST',
        url: '/spawn-session',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          spawnNonce: 'shutdown-spawn-nonce',
        }),
      });

      expect(spawnResponse.statusCode).toBe(503);
      expect(spawnResponse.json()).toEqual({
        success: false,
        error: 'Daemon is shutting down',
        errorCode: 'daemon_shutting_down',
      });

      const continueResponse = await app.inject({
        method: 'POST',
        url: '/continue-with-replay',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({
          directory: '/tmp',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          replay: { previousSessionId: 'sess-prev' },
        }),
      });

      expect(continueResponse.statusCode).toBe(503);
      expect(continueResponse.json()).toEqual({
        success: false,
        error: 'Daemon is shutting down',
        errorCode: 'daemon_shutting_down',
      });

      expect(spawnSession).not.toHaveBeenCalled();

      const nonceResponse = await app.inject({
        method: 'POST',
        url: '/spawn-session/resolve',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ spawnNonce: 'shutdown-spawn-nonce' }),
      });

      expect(nonceResponse.statusCode).toBe(200);
      expect(nonceResponse.json()).toEqual({
        success: true,
        status: 'not_found',
      });
      barrier.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 75));
    } finally {
      barrier.resolve(undefined);
      await app.close();
    }
  });

  it('stops all tracked sessions when stopSessions is true (then requests shutdown)', async () => {
    const calls: string[] = [];

    const app = createDaemonControlApp({
      getChildren: () => [
        { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1' },
        { startedBy: 'daemon', pid: 222 },
        { startedBy: 'terminal', pid: 333, happySessionId: 'sess-3' },
      ],
      machineId: 'machine_local',
      stopSession: async (sessionId) => {
        calls.push(`stop:${sessionId}`);
        return { status: 'stopped' as const };
      },
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {
        calls.push('shutdown');
      },
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ stopSessions: true }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'stopping',
        sessionResults: [
          { sessionId: 'sess-1', result: { status: 'stopped' } },
          { sessionId: 'PID-222', result: { status: 'stopped' } },
          { sessionId: 'sess-3', result: { status: 'stopped' } },
        ],
      });

      await vi.waitFor(() => expect(calls).toEqual(['stop:sess-1', 'stop:PID-222', 'stop:sess-3', 'shutdown']));
    } finally {
      await app.close();
    }
  });

  it('keeps the daemon available for retry when canonical runner exit confirmation is incomplete', async () => {
    const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    await once(child, 'message');
    if (!child.pid) throw new Error('test runner has no PID');
    const identity = await readProcessIdentityByPid(child.pid);
    if (identity?.processStartTimeMs === undefined) throw new Error('test runner has no process identity');
    const tracked = { startedBy: 'daemon' as const, pid: child.pid, happySessionId: 'unconfirmed-exit', childProcess: child,
      processStartTimeMs: identity.processStartTimeMs };
    const runners = new Map([[child.pid, tracked]]);
    const requestShutdown = vi.fn();
    const requestSelfRestart = vi.fn(async () => {});
    const kill = process.kill.bind(process);
    // Hold only the native signal boundary so the real runner stays alive.
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === child.pid && (signal === 'SIGTERM' || signal === 'SIGKILL')) return true;
      return kill(pid, signal);
    });
    const stopSession = createStopSession({
      pidToTrackedSession: runners,
      // The filesystem boundary has no terminal attachment for this owned child.
      readHostAttachmentState: async () => ({ status: 'absent' }),
      waitForTrackedRunnersExit: async ({ trackedPids }) => await waitForTrackedRunnerProcessesExit({
        runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0,
      }),
    });
    const app = createDaemonControlApp({
      getChildren: () => [...runners.values()],
      machineId: 'machine_local',
      stopSession: (sessionId, _intent, signal) => stopSession(sessionId, { metadataContext: { credentials: { token: 'test-token', encryption: null }, currentness: { signal } } }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown,
      requestSelfRestart,
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });
    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST', url: '/stop',
        headers: { 'x-happier-daemon-token': 'test-token' },
        payload: { stopSessions: true },
      });
      expect(response.json()).toEqual({
        status: 'session_cleanup_incomplete',
        sessionResults: [{ sessionId: 'unconfirmed-exit', result: { status: 'incomplete', reason: 'runner_exit_timeout' } }],
      });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(requestShutdown).not.toHaveBeenCalled();

      const restartResponse = await app.inject({
        method: 'POST', url: '/restart',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });
      expect(restartResponse.statusCode).toBe(202);
      expect(restartResponse.json()).toEqual({ status: 'restarting' });
      expect(requestSelfRestart).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      vi.restoreAllMocks();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

  it('prepares tracked sessions before stopping them during daemon shutdown', async () => {
    const calls: string[] = [];
    const child = { startedBy: 'daemon' as const, pid: 111, happySessionId: 'sess-1' };

    const app = createDaemonControlApp({
      getChildren: () => [child],
      machineId: 'machine_local',
      prepareStopSession: async (trackedSession) => {
        calls.push(`prepare:${trackedSession.happySessionId}`);
      },
      stopSession: async (sessionId) => {
        calls.push(`stop:${sessionId}`);
        return { status: 'stopped' as const };
      },
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {
        calls.push('shutdown');
      },
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    } as Parameters<typeof createDaemonControlApp>[0] & {
      prepareStopSession: (trackedSession: typeof child) => Promise<void>;
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' },
        payload: JSON.stringify({ stopSessions: true }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'stopping',
        sessionResults: [{ sessionId: 'sess-1', result: { status: 'stopped' } }],
      });

      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(calls).toEqual(['prepare:sess-1', 'stop:sess-1', 'shutdown']);
    } finally {
      await app.close();
    }
  });

  it('does not stop sessions by default', async () => {
    const calls: string[] = [];

    const app = createDaemonControlApp({
      getChildren: () => [{ startedBy: 'daemon', pid: 111, happySessionId: 'sess-1' }],
      machineId: 'machine_local',
      stopSession: async (sessionId) => {
        calls.push(`stop:${sessionId}`);
        return { status: 'stopped' as const };
      },
      spawnSession: async () => ({ type: 'success', sessionId: 'happy-test-123' }),
      requestShutdown: () => {
        calls.push('shutdown');
      },
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
    });

    try {
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/stop',
        headers: { 'x-happier-daemon-token': 'test-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'stopping' });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(calls).toEqual(['shutdown']);
    } finally {
      await app.close();
    }
  });
});
