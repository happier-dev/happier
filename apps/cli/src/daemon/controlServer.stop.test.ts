import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

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
    vi.restoreAllMocks();
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
        payload: JSON.stringify({ transferManagedLocalServices: true }),
      });
      expect(res.statusCode).toBe(200);

      await vi.waitFor(() => expect(beforeShutdown).toHaveBeenCalledWith({
        managedLocalServicesDisposition: 'transfer',
      }));
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
      expect(res.json()).toEqual({ status: 'stopping' });

      expect(calls).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(calls).toEqual(['stop:sess-1', 'stop:PID-222', 'stop:sess-3', 'shutdown']);
    } finally {
      await app.close();
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
      expect(res.json()).toEqual({ status: 'stopping' });

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
