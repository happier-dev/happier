import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonControlApp } from './controlServer';

const headers = { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' };

describe('spawn nonce terminal wait', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it('settles recovered readiness even while the recovery read is still pending', async () => {
    let release!: () => void;
    const recovery = new Promise<void>((resolve) => { release = resolve; });
    const resolveRecoveredSpawnNonce = vi.fn(async () => { await recovery; return { type: 'pending' as const }; });
    const children = [{ startedBy: 'daemon', pid: 124, happySessionId: 'PID-124', spawnOptions: { directory: '/tmp', spawnNonce: 'recovery-race' } }];
    const app = createDaemonControlApp({
      getChildren: () => children, machineId: 'machine-local', controlToken: 'test-token', spawnSession: vi.fn(),
      resolveRecoveredSpawnNonce, stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {},
      onHappySessionWebhook: async (sessionId) => { children[0]!.happySessionId = sessionId; },
    });
    try {
      await app.ready();
      let settled = false;
      const wait = app.inject({ method: 'POST', url: '/spawn-session/resolve', headers, payload: { spawnNonce: 'recovery-race', timeoutMs: 10_000 } })
        .then((response) => { settled = true; return response; });
      await vi.waitFor(() => expect(resolveRecoveredSpawnNonce).toHaveBeenCalledOnce());
      await app.inject({ method: 'POST', url: '/session-started', headers, payload: { sessionId: 'session-recovery-race', metadata: {} } });
      await vi.waitFor(() => expect(settled).toBe(true));
      expect((await wait).json()).toEqual({ success: true, status: 'success', sessionId: 'session-recovery-race' });
    } finally { release(); await app.close(); }
  });

  it('keeps one concurrent HTTP waiter alive when another reaches its deadline', async () => {
    vi.stubEnv('HAPPIER_DAEMON_SPAWN_NONCE_PENDING_TTL_MS', '25');
    const children = [{ startedBy: 'daemon', pid: 125, happySessionId: 'PID-125', spawnOptions: { directory: '/tmp', spawnNonce: 'concurrent' } }];
    const app = createDaemonControlApp({
      getChildren: () => children, machineId: 'machine-local', controlToken: 'test-token', spawnSession: vi.fn(),
      stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {},
      onHappySessionWebhook: async (sessionId) => { children[0]!.happySessionId = sessionId; },
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const post = async (path: string, payload: unknown) => {
        const response = await fetch(`${address}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
        return await response.json();
      };
      const first = post('/spawn-session/resolve', { spawnNonce: 'concurrent', timeoutMs: 50 });
      const second = post('/spawn-session/resolve', { spawnNonce: 'concurrent', timeoutMs: 10_000 });
      expect(await first).toEqual({ success: true, status: 'pending' });
      expect(await post('/spawn-session/resolve', { spawnNonce: 'concurrent' })).toEqual({ success: true, status: 'pending' });
      await post('/session-started', { sessionId: 'session-concurrent', metadata: {} });
      expect(await second).toEqual({ success: true, status: 'success', sessionId: 'session-concurrent' });
    } finally { await app.close(); }
  });

  it('bounds a recovery read by the caller deadline without inventing a terminal fact', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local', controlToken: 'test-token', spawnSession: vi.fn(),
      resolveRecoveredSpawnNonce: () => new Promise<never>(() => {}),
      stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {}, onHappySessionWebhook: () => {},
    });
    try {
      await app.ready();
      const result = await app.inject({ method: 'POST', url: '/spawn-session/resolve', headers, payload: { spawnNonce: 'unknown', timeoutMs: 50 } });
      expect(result.json()).toEqual({ success: true, status: 'not_found' });
    } finally { await app.close(); }
  });

  it.each(['success', 'error'] as const)('parks until the existing spawn owner publishes %s', async (status) => {
    let finish!: () => void;
    const terminal = new Promise<void>((resolve) => { finish = resolve; });
    const spawnSession = vi.fn(async () => {
      await terminal;
      return status === 'success'
        ? { type: 'success' as const, sessionId: 'session-waited' }
        : { type: 'error' as const, errorCode: 'agent_signed_out' as const, agentId: 'codex', errorMessage: 'Sign in first' };
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local', controlToken: 'test-token',
      spawnSession, stopSession: async () => ({ status: 'not_found' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
    });
    try {
      await app.ready();
      const spawn = app.inject({ method: 'POST', url: '/spawn-session', headers, payload: { directory: '/tmp', spawnNonce: 'waiting' } });
      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce());
      const interval = vi.spyOn(globalThis, 'setInterval');
      let settled = false;
      const wait = app.inject({ method: 'POST', url: '/spawn-session/resolve', headers, payload: { spawnNonce: 'waiting', timeoutMs: 30 * 24 * 60 * 60_000 } })
        .then((response) => { settled = true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      finish();
      expect((await wait).json()).toEqual(status === 'success'
        ? { success: true, status: 'success', sessionId: 'session-waited' }
        : { success: true, status: 'error', errorCode: 'agent_signed_out', agentId: 'codex', errorMessage: 'Sign in first' });
      expect(interval).not.toHaveBeenCalled();
      interval.mockRestore();
      await spawn;
    } finally { finish(); await app.close(); }
  });

  it('returns the current pending snapshot only when the caller deadline expires', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [{ startedBy: 'daemon', pid: 123, spawnOptions: { directory: '/tmp', spawnNonce: 'pending' } }],
      machineId: 'machine-local', controlToken: 'test-token', spawnSession: vi.fn(),
      stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {}, onHappySessionWebhook: () => {},
    });
    try {
      await app.ready();
      const startedAt = Date.now();
      const result = await app.inject({ method: 'POST', url: '/spawn-session/resolve', headers, payload: { spawnNonce: 'pending', timeoutMs: 50 } });
      expect(result.json()).toEqual({ success: true, status: 'pending' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    } finally { await app.close(); }
  });

  it('rejoins recovered admission after control-server restart and settles on readiness', async () => {
    const children = [{ startedBy: 'daemon', pid: 124, happySessionId: 'PID-124', spawnOptions: { directory: '/tmp', spawnNonce: 'recovered' } }];
    const makeApp = () => createDaemonControlApp({
      getChildren: () => children, machineId: 'machine-local', controlToken: 'test-token', spawnSession: vi.fn(),
      resolveRecoveredSpawnNonce: async () => ({ type: 'pending' }),
      stopSession: async () => ({ status: 'not_found' }), requestShutdown: () => {},
      onHappySessionWebhook: async (sessionId) => { children[0]!.happySessionId = sessionId; },
    });
    const previous = makeApp();
    await previous.ready();
    await previous.inject({ method: 'POST', url: '/spawn-session/resolve', headers, payload: { spawnNonce: 'recovered' } });
    await previous.close();
    const app = makeApp();
    try {
      await app.ready();
      let settled = false;
      const wait = app.inject({ method: 'POST', url: '/spawn-session/resolve', headers, payload: { spawnNonce: 'recovered', timeoutMs: 10_000 } })
        .then((result) => { settled = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      await app.inject({ method: 'POST', url: '/session-started', headers, payload: { sessionId: 'session-recovered', metadata: {} } });
      expect((await wait).json()).toEqual({ success: true, status: 'success', sessionId: 'session-recovered' });
    } finally { await app.close(); }
  });
});
