import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server: /stop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops all tracked sessions when stopSessions is true (then requests shutdown)', async () => {
    const calls: string[] = [];

    const app = createDaemonControlApp({
      getChildren: () => [
        { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1' },
        { startedBy: 'daemon', pid: 222 },
        { startedBy: 'terminal', pid: 333, happySessionId: 'sess-3' },
      ],
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
