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
        return true;
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
        return true;
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

  it('does not stop sessions by default', async () => {
    const calls: string[] = [];

    const app = createDaemonControlApp({
      getChildren: () => [{ startedBy: 'daemon', pid: 111, happySessionId: 'sess-1' }],
      machineId: 'machine_local',
      stopSession: async (sessionId) => {
        calls.push(`stop:${sessionId}`);
        return true;
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
