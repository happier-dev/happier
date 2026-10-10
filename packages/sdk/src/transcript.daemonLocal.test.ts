import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { connect } from './index.js';

describe('public transcript following at a daemon-local Action endpoint', () => {
  it('reads the transcript without waiting for a Home viewer socket', async () => {
    // A daemon-local HTTP listener serves Actions, not the Home viewer socket.
    // This is the actual network boundary; SDK follower/transport logic stays real.
    let followReads = 0;
    let cancelledWaits = 0;
    let append: (() => void) | undefined;
    const inputs: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      response.setHeader('content-type', 'application/json');
      if (!path.startsWith('/v1/actions/')) {
        response.writeHead(404).end('{}');
        return;
      }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const actionId = decodeURIComponent(path.slice('/v1/actions/'.length));
      if (actionId === 'transcript.follow') {
        followReads++;
        inputs.push((JSON.parse(body) as { input: Record<string, unknown> }).input);
        if (followReads > 1) {
          response.once('close', () => { if (!response.writableEnded) cancelledWaits++; });
          append = () => response.end(JSON.stringify({ v: 1, actionId, execution: { ok: true,
            result: { items: [{ id: '2', seq: 2, text: 'appended without a socket' }], nextCursor: '2', truncated: false } } }));
          return;
        }
      }
      const result = actionId === 'transcript.follow'
        ? { items: [{ id: '1', seq: 1, text: 'daemon transcript' }], nextCursor: '1', truncated: false }
        : actionId === 'session.status.get' ? { session: { active: true } } : { ok: true, released: true };
      response.end(JSON.stringify({ v: 1, actionId, execution: { ok: true, result } }));
    });
    server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener address');
    const client = connect({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const iterator = client.sessions.get('session-1').followTranscript({ cursor: '0' })[Symbol.asyncIterator]();
    const next = iterator.next();
    void next.catch(() => undefined);
    try {
      await expect.poll(() => followReads).toBe(1);
      await expect(next).resolves.toMatchObject({ done: false, value: { id: '1', text: 'daemon transcript' } });
      const pushed = iterator.next();
      await expect.poll(() => followReads).toBe(2);
      expect(inputs[1]).toMatchObject({ cursor: '1', waitForChanges: true });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(followReads).toBe(2);
      const responseAt = performance.now();
      append?.();
      await expect(pushed).resolves.toMatchObject({ done: false, value: { id: '2' } });
      const actionToSdkMs = performance.now() - responseAt;
      console.info('WAKE_TIMING', JSON.stringify({ actionToSdkMs }));
      expect(actionToSdkMs).toBeLessThan(1000);
      const cancelled = iterator.next();
      await expect.poll(() => followReads).toBe(3);
      await iterator.return?.();
      await expect(cancelled).resolves.toMatchObject({ done: true });
      await expect.poll(() => cancelledWaits).toBe(1);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
