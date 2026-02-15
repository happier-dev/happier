import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session delegate start (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-delegate-start-'));

    const sessionId = 'sess_integration_delegate_start_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64Session(
      encryptWithDataKey({ path: '/tmp', flavor: 'claude' }, dek),
      'base64',
    );
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              metadata: metadataCiphertext,
              metadataVersion: 0,
              agentState: null,
              agentStateVersion: 0,
              dataEncryptionKey: dataEncryptionKeyBase64,
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

    const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');

    mockIo.mockImplementation(() => {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const on = vi.fn((event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      });

      const emit = vi.fn((event: string, data: any, cb?: (...args: any[]) => void) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        const decrypted = decrypt(dek, 'dataKey', decodedParams) as any;
        expect(decrypted.intent).toBe('delegate');
        expect(decrypted.backendId).toBe('codex');
        expect(decrypted.permissionMode).toBe('workspace_write');
        expect(decrypted.intentInput?.backendId).toBe('codex');

        const resultPayload = { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' };
        cb?.({
          ok: true,
          result: encodeBase64Rpc(encrypt(dek, 'dataKey', resultPayload), 'base64'),
        });
      });

      const connect = vi.fn(() => {
        const list = handlers.get('connect') ?? [];
        for (const fn of list) fn();
      });

      return { on, emit, connect, disconnect: vi.fn(), close: vi.fn() };
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

  it('returns a session_delegate_start JSON envelope with per-backend results', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        [
          'delegate',
          'start',
          'sess_integration_delegate_start_123',
          '--backends',
          'codex',
          '--instructions',
          'Delegate.',
          '--json',
        ],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'dataKey',
              publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
              machineKey: machineKeySeed,
            },
          }),
        },
      );

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_delegate_start');
      expect(parsed.data?.sessionId).toBe('sess_integration_delegate_start_123');
      expect(parsed.data?.results?.length).toBe(1);
      expect(parsed.data?.results?.[0]?.key).toBe('codex');
    } finally {
      logSpy.mockRestore();
    }
  });
});
