import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { requestDaemonSessionConnectedServiceAuthSwitch } from './controlClient';

afterEach(() => vi.unstubAllEnvs());

describe('session auth switch observation lifetime', () => {
  it('waits for the real turn boundary and retains explicit caller cancellation and deadlines', async () => {
    vi.stubEnv('HAPPIER_DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_HTTP_TIMEOUT_MS', '1000');
    vi.stubEnv('HAPPIER_DAEMON_HTTP_TIMEOUT', '100');
    let started!: () => void;
    let requestStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const paths: string[] = [];
    const result = { ok: true, action: 'hot_applied' };
    const server = createServer((request, response) => {
      request.resume();
      paths.push(request.url!);
      release = () => response.end(JSON.stringify({ result }));
      started();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const target = { pid: process.pid, httpPort: address.port, controlToken: 'test-control' };
    const body = { sessionId: 'session', agentId: 'codex', bindings: { v: 2, bindingsByServiceId: {} } } as const;
    try {
      let settled = false;
      const observation = requestDaemonSessionConnectedServiceAuthSwitch(body, { target })
        .then(value => ({ result: value }), error => ({ error }))
        .finally(() => { settled = true; });
      await requestStarted;
      await new Promise<void>(resolve => setTimeout(resolve, 1100));
      expect(settled).toBe(false);
      release();
      await expect(observation).resolves.toEqual({ result });

      requestStarted = new Promise<void>(resolve => { started = resolve; });
      const cancellation = new AbortController();
      const cancelled = requestDaemonSessionConnectedServiceAuthSwitch(body, { target, signal: cancellation.signal });
      const cancelledAssertion = expect(cancelled).rejects.toThrow('caller retired');
      await requestStarted;
      cancellation.abort(new Error('caller retired'));
      await cancelledAssertion;

      requestStarted = new Promise<void>(resolve => { started = resolve; });
      const bounded = requestDaemonSessionConnectedServiceAuthSwitch(body, { target, timeoutMs: 100 });
      const boundedAssertion = expect(bounded).rejects.toThrow(/timeout/i);
      await requestStarted;
      await boundedAssertion;
      expect(paths).toEqual(Array(3).fill('/connected-service-auth/session/switch'));
    } finally {
      release?.();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
