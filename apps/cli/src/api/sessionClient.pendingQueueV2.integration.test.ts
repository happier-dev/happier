import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { bindApiSessionSocketPairMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

type PendingRow = { localId?: unknown };

describe('ApiSessionClient pending queue V2 helpers', () => {
  const envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let server: Server | null = null;
  let serverUrl = '';
  let pendingRows: PendingRow[] = [];
  const discardedLocalIds: string[] = [];

  async function createClient() {
    const { reloadConfiguration } = await import('@/configuration');
    const { ApiSessionClient } = await import('./session/sessionClient');

    const sessionSocket = createApiSessionSocketStub();
    const userSocket = createApiSessionSocketStub();
    bindApiSessionSocketPairMock(mockIo, {
      sessionSocket,
      userSocket,
      fallbackSocket: sessionSocket,
    });

    reloadConfiguration();
    const session = createMockSession({
      metadata: { path: '/tmp', host: 'localhost' },
    });
    return new ApiSessionClient('test-token', session);
  }

  beforeEach(async () => {
    pendingRows = [];
    discardedLocalIds.length = 0;

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/v2/sessions/test-session-id/pending') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ pending: pendingRows }));
        return;
      }

      const discard = url.pathname.match(/^\/v2\/sessions\/test-session-id\/pending\/([^/]+)\/discard$/);
      if (req.method === 'POST' && discard) {
        const localId = decodeURIComponent(discard[1] ?? '');
        discardedLocalIds.push(localId);
        pendingRows = pendingRows.filter((row) => row.localId !== localId);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve pending queue test server address');
    }

    serverUrl = `http://127.0.0.1:${address.port}`;
    envScope.patch({
      HAPPIER_SERVER_URL: serverUrl,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;

    envScope.restore();

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('lists pending localIds from /v2/sessions/:id/pending', async () => {
    pendingRows = [{ localId: 'a' }, { localId: 'b' }, { localId: 123 }, {}];
    const client = await createClient();

    await expect(client.listPendingMessageQueueV2LocalIds()).resolves.toEqual(['a', 'b']);
  });

  it('peeks pending count via list', async () => {
    pendingRows = [{ localId: 'a' }];
    const client = await createClient();

    await expect(client.peekPendingMessageQueueV2Count()).resolves.toBe(1);
  });

  it('discards all pending messages via /discard endpoint', async () => {
    pendingRows = [{ localId: 'a' }, { localId: 'b' }];
    const client = await createClient();

    await expect(client.discardPendingMessageQueueV2All({ reason: 'manual' })).resolves.toBe(2);
    expect(discardedLocalIds).toEqual(['a', 'b']);
  });
});
