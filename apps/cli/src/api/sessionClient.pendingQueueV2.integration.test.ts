import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

type PendingRow = { localId?: unknown };

function createMockSocket() {
  return {
    connected: false,
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
    emit: vi.fn(),
    emitWithAck: vi.fn(),
  };
}

describe('ApiSessionClient pending queue V2 helpers', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  let server: Server | null = null;
  let serverUrl = '';
  let pendingRows: PendingRow[] = [];
  const discardedLocalIds: string[] = [];

  async function createClient() {
    const { reloadConfiguration } = await import('@/configuration');
    const { ApiSessionClient } = await import('./session/sessionClient');

    const mockSocket = createMockSocket();
    const mockUserSocket = createMockSocket();
    mockIo.mockReset();
    mockIo.mockImplementationOnce(() => mockSocket as any).mockImplementationOnce(() => mockUserSocket as any);

    reloadConfiguration();
    const session: any = {
      id: 'test-session-id',
      seq: 0,
      metadata: { path: '/tmp', host: 'localhost' },
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
    };
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
    process.env.HAPPIER_SERVER_URL = serverUrl;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;

    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;

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

