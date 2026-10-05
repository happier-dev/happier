import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDaemonSignedRootActionExecution } from './controlClient';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';

describe('signed root Action acknowledgement', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('lets the idle owner return after the generic transport deadline', async () => {
    vi.useFakeTimers();
    // Clock and HTTP are system boundaries; native AbortSignal timers use a separate clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal('fetch', (_url: unknown, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ ok: true, result: { idle: true, observedAt: 301000 } })), 301000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
    }));
    const result = requestDaemonSignedRootActionExecution({ actionId: 'session.wait.idle', input: { sessionId: 'created-session', timeoutSeconds: 600 } }, {
      target: { pid: process.pid, httpPort: 1 },
    });
    const observed = result.then((value) => value);
    await vi.advanceTimersByTimeAsync(301000);
    expect(await observed).toMatchObject({ ok: true, result: { idle: true } });
  });
  it('does not report a lost session-create acknowledgement as a daemon outage or retry creation', async () => {
    const createdSessions: string[] = [];
    const server = createServer((request) => {
      request.resume();
      request.on('end', () => { createdSessions.push('session-created'); });
      // Real HTTP loss after the write committed: no response is sent.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      const input = SessionSpawnNewInputV2Schema.parse({
        creationKey: 'root-create-ack', executionTarget: { serverId: 'server-local', machineId: 'machine-local' },
        directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      });
      const result = await requestDaemonSignedRootActionExecution({ actionId: 'session.spawn_new', input }, {
        target: { pid: process.pid, httpPort: address.port }, timeoutMs: 100,
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
      expect(createdSessions).toEqual(['session-created']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports an idle observation deadline as timeout, not a daemon outage', async () => {
    const server = createServer((request) => request.resume());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      await expect(requestDaemonSignedRootActionExecution({ actionId: 'session.wait.idle', input: { sessionId: 'created-session' } }, {
        target: { pid: process.pid, httpPort: address.port }, timeoutMs: 100,
      })).resolves.toMatchObject({ ok: false, errorCode: 'timeout' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
