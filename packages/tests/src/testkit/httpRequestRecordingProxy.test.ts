import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { startHttpRequestRecordingProxy } from './httpRequestRecordingProxy';
import { withTimeoutMs } from './timing/withTimeout';

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForNoSockets(sockets: ReadonlySet<Socket>, label: string): Promise<void> {
  await withTimeoutMs({
    promise: new Promise<void>((resolve) => {
      const check = () => {
        if (sockets.size === 0) {
          resolve();
          return;
        }
        setTimeout(check, 25);
      };
      check();
    }),
    timeoutMs: 1_000,
    label,
  });
}

describe('startHttpRequestRecordingProxy', () => {
  it('can withhold a committed upstream response until the caller releases it', async () => {
    let upstreamCommitCount = 0;
    const target = createServer((_req, res) => {
      upstreamCommitCount += 1;
      res.statusCode = 200;
      res.end('committed');
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    let releaseResponse = (): void => {};
    const responseRelease = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let observeCommittedResponse = (): void => {};
    const committedResponseObserved = new Promise<void>((resolve) => {
      observeCommittedResponse = resolve;
    });
    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
      beforeForwardResponse: async (request) => {
        expect(request).toMatchObject({
          method: 'POST',
          path: '/commit',
          statusCode: 200,
        });
        observeCommittedResponse();
        await responseRelease;
      },
    });
    let fetchSettled = false;
    const responsePromise = fetch(`${proxy.baseUrl}/commit`, {
      method: 'POST',
      body: 'payload',
    }).then(async (response) => {
      fetchSettled = true;
      return {
        status: response.status,
        body: await response.text(),
      };
    });

    try {
      await withTimeoutMs({
        promise: committedResponseObserved,
        timeoutMs: 1_000,
        label: 'committed upstream response to reach proxy latch',
      });
      expect(upstreamCommitCount).toBe(1);
      expect(fetchSettled).toBe(false);

      releaseResponse();
      await expect(withTimeoutMs({
        promise: responsePromise,
        timeoutMs: 1_000,
        label: 'released proxy response',
      })).resolves.toEqual({
        status: 200,
        body: 'committed',
      });
    } finally {
      releaseResponse();
      await proxy.stop().catch(() => {});
      await closeServer(target);
    }
  });

  it('closes upgraded upstream sockets when stopped', async () => {
    const targetSockets = new Set<Socket>();
    const target = createServer((_req, res) => {
      res.end('ok');
    });
    target.on('connection', (socket) => {
      targetSockets.add(socket);
      socket.once('close', () => targetSockets.delete(socket));
    });
    target.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.resume();
      const ping = setInterval(() => {
        if (!socket.destroyed) socket.write('ping');
      }, 25);
      socket.once('close', () => clearInterval(ping));
      socket.once('error', () => clearInterval(ping));
    });
    await listen(target);
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== 'object') throw new Error('target server did not bind');

    const proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: `http://127.0.0.1:${targetAddress.port}`,
    });
    const proxyUrl = new URL(proxy.baseUrl);
    const socket = connect(Number(proxyUrl.port), proxyUrl.hostname);
    let stopPromise: Promise<void> | null = null;

    try {
      await once(socket, 'connect');
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: ${proxyUrl.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'));
      await once(socket, 'data');
      expect(targetSockets.size).toBeGreaterThan(0);

      stopPromise = proxy.stop();
      await expect(withTimeoutMs({
        promise: stopPromise,
        timeoutMs: 1_000,
        label: 'http request recording proxy stop',
      })).resolves.toBeUndefined();
      await expect(waitForNoSockets(targetSockets, 'http request recording upstream sockets to close')).resolves.toBeUndefined();
    } finally {
      socket.destroy();
      for (const targetSocket of targetSockets) targetSocket.destroy();
      await stopPromise?.catch(() => {});
      await closeServer(target);
    }
  });
});
