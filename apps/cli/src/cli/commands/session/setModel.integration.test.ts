import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session set-model (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  const sessionId = 'sess_integration_set_model_123';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-set-model-'));

    const secret = new Uint8Array(32).fill(9);
    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64(encryptLegacy({ path: '/tmp', host: 'host1', tag: 'MyTag' }, secret), 'base64');

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: false,
              activeAt: 0,
              metadata: metadataCiphertext,
              metadataVersion: 0,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: null,
              share: null,
              archivedAt: null,
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    mockIo.mockReset();
    mockIo.mockImplementation(() => {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const on = vi.fn((event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      });
      const off = vi.fn((event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        handlers.set(event, list.filter((v) => v !== cb));
      });
      const connect = vi.fn(() => {
        const list = handlers.get('connect') ?? [];
        for (const cb of list) cb();
      });
      const emit = vi.fn(async (event: string, ...args: any[]) => {
        if (event !== 'update-metadata') return;
        const [data, callback] = args;
        const { decodeBase64, decryptLegacy } = await import('@/api/encryption');
        const decrypted = decryptLegacy(decodeBase64(String(data?.metadata ?? ''), 'base64'), secret);

        expect(decrypted?.modelOverrideV1?.v).toBe(1);
        expect(decrypted?.modelOverrideV1?.modelId).toBe('claude-sonnet-4-0');
        expect(typeof decrypted?.modelOverrideV1?.updatedAt).toBe('number');

        if (typeof callback === 'function') {
          callback({ result: 'success', version: 1, metadata: data.metadata });
        }
      });

      return {
        on,
        off,
        connect,
        emit,
        disconnect: vi.fn(),
        close: vi.fn(),
      };
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    }
    server = null;
    if (happyHomeDir) await rm(happyHomeDir, { recursive: true, force: true });

    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('publishes model override to encrypted metadata via update-metadata', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

    try {
      await handleSessionCommand(['set-model', sessionId, 'claude-sonnet-4-0', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
        }),
      });

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_set_model');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.modelId).toBe('claude-sonnet-4-0');
    } finally {
      logSpy.mockRestore();
    }
  });
});

