import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session run stream-* (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-run-stream-'));

    const sessionId = 'sess_integration_stream_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64Session(encryptWithDataKey({ path: '/tmp', flavor: 'claude' }, dek), 'base64');
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            sessions: [
              {
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
                dataEncryptionKey: dataEncryptionKeyBase64,
                share: null,
              },
            ],
            nextCursor: null,
            hasNext: false,
          }),
        );
        return;
      }
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
              dataEncryptionKey: dataEncryptionKeyBase64,
              share: null,
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
        const method = String(data.method ?? '');
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        const decrypted = decrypt(dek, 'dataKey', decodedParams) as any;

        if (method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START)) {
          expect(decrypted).toMatchObject({ runId: 'run_1', message: 'hello' });
          const encryptedResult = encodeBase64Rpc(encrypt(dek, 'dataKey', { streamId: 'stream_1' }), 'base64');
          cb?.({ ok: true, result: encryptedResult });
          return;
        }
        if (method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ)) {
          expect(decrypted).toMatchObject({ runId: 'run_1', streamId: 'stream_1', cursor: 0 });
          const payload = { streamId: 'stream_1', events: [{ t: 'delta', textDelta: 'hi' }], nextCursor: 1, done: false };
          const encryptedResult = encodeBase64Rpc(encrypt(dek, 'dataKey', payload), 'base64');
          cb?.({ ok: true, result: encryptedResult });
          return;
        }
        if (method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL)) {
          expect(decrypted).toMatchObject({ runId: 'run_1', streamId: 'stream_1' });
          const encryptedResult = encodeBase64Rpc(encrypt(dek, 'dataKey', { ok: true }), 'base64');
          cb?.({ ok: true, result: encryptedResult });
          return;
        }
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

  it('supports stream-start', async () => {
    const { handleSessionCommand } = await import('../index');
    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['run', 'stream-start', 'sess_integration_stream_123', 'run_1', 'hello', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_stream_start');
      expect(parsed.data?.streamId).toBe('stream_1');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('supports stream-read', async () => {
    const { handleSessionCommand } = await import('../index');
    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['run', 'stream-read', 'sess_integration_stream_123', 'run_1', 'stream_1', '--cursor', '0', '--json'],
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
      expect(parsed.kind).toBe('session_run_stream_read');
      expect(parsed.data?.streamId).toBe('stream_1');
      expect(parsed.data?.events?.[0]?.t).toBe('delta');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('supports stream-cancel', async () => {
    const { handleSessionCommand } = await import('../index');
    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['run', 'stream-cancel', 'sess_integration_stream_123', 'run_1', 'stream_1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_stream_cancel');
      expect(parsed.data?.streamId).toBe('stream_1');
      expect(parsed.data?.cancelled).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
