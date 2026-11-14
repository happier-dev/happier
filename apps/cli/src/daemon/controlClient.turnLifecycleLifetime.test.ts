import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { notifyDaemonConnectedServiceTurnLifecycle } from './controlClient';

afterEach(() => vi.unstubAllEnvs());

describe('daemon turn lifecycle publication lifetime', () => {
  it('awaits marker custody beyond the generic control deadline and respects caller cancellation and deadlines', async () => {
    vi.stubEnv('HAPPIER_DAEMON_HTTP_TIMEOUT', '100');
    let started!: () => void;
    let requestStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const result = { status: 'continue', turnCustody: { status: 'recorded', activeTurnId: 'turn' } };
    const server = createServer((request, response) => {
      request.resume();
      release = () => response.end(JSON.stringify({ ok: true, result }));
      started();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const target = { pid: process.pid, httpPort: address.port, controlToken: 'test-control' };
    const body = { sessionId: 'session', turnId: 'turn', event: 'task_started' } as const;
    try {
      let settled = false;
      const publication = notifyDaemonConnectedServiceTurnLifecycle(body, { target })
        .then(value => ({ result: value }), error => ({ error }))
        .finally(() => { settled = true; });
      await requestStarted;
      await new Promise<void>(resolve => setTimeout(resolve, 250));
      expect(settled).toBe(false);
      release();
      await expect(publication).resolves.toEqual({ result });

      requestStarted = new Promise<void>(resolve => { started = resolve; });
      const cancellation = new AbortController();
      const cancelled = notifyDaemonConnectedServiceTurnLifecycle(body, { target, signal: cancellation.signal });
      const cancelledAssertion = expect(cancelled).resolves.toMatchObject({ errorCode: 'cancelled' });
      await requestStarted;
      cancellation.abort(new Error('caller retired'));
      await cancelledAssertion;

      requestStarted = new Promise<void>(resolve => { started = resolve; });
      const bounded = notifyDaemonConnectedServiceTurnLifecycle(body, { target, timeoutMs: 100 });
      const boundedAssertion = expect(bounded).resolves.toMatchObject({ errorCode: 'timeout' });
      await requestStarted;
      await boundedAssertion;
    } finally {
      release?.();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
