import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

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
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-run-stream-');

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

    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
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
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('supports stream-start', async () => {
    const { handleSessionCommand } = await import('../index');
    const output = captureConsoleJsonOutput();
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

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_stream_start');
      expect(parsed.data?.streamId).toBe('stream_1');
    } finally {
      output.restore();
    }
  });

  it('supports stream-read', async () => {
    const { handleSessionCommand } = await import('../index');
    const output = captureConsoleJsonOutput();
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

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_stream_read');
      expect(parsed.data?.streamId).toBe('stream_1');
      expect(parsed.data?.events?.[0]?.t).toBe('delta');
    } finally {
      output.restore();
    }
  });

  it('supports stream-cancel', async () => {
    const { handleSessionCommand } = await import('../index');
    const output = captureConsoleJsonOutput();
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

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_stream_cancel');
      expect(parsed.data?.streamId).toBe('stream_1');
      expect(parsed.data?.cancelled).toBe(true);
    } finally {
      output.restore();
    }
  });
});
