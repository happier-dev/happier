import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';

type StartedServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

async function startHealthServer(handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>): Promise<StartedServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected AddressInfo from test HTTP server');
  }
  return {
    baseUrl: `http://127.0.0.1:${(address satisfies AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('waitForOpenCodeServerHealth', () => {
  const servers = new Set<StartedServer>();

  afterEach(async () => {
    for (const server of servers) {
      await server.close().catch(() => {});
    }
    servers.clear();
  });

  it('succeeds when the health endpoint requires basic auth headers', async () => {
    const expectedAuth = `Basic ${Buffer.from('tester:top-secret', 'utf8').toString('base64')}`;
    const server = await startHealthServer((req, res) => {
      if (req.url !== '/global/health') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: 'fake' }));
    });
    servers.add(server);

    await expect(
      waitForOpenCodeServerHealth({
        baseUrl: server.baseUrl,
        timeoutMs: 2_000,
        pollIntervalMs: 25,
        headers: {
          Authorization: expectedAuth,
        },
      }),
    ).resolves.toBeUndefined();
  });
});
