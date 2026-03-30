import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session run send (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_ACTIONS_SETTINGS_V1'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-run-send-');

    const sessionId = 'sess_integration_run_send_123';
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
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'execution.run.send': { enabled: true, disabledSurfaces: [], disabledPlacements: [] },
      },
    });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        expect(String(data.method ?? '')).toBe(`${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}`);
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        const decrypted = decrypt(dek, 'dataKey', decodedParams) as any;
        expect(decrypted).toMatchObject({
          runId: 'run_1',
          message: 'hello run',
          delivery: 'steer_if_supported',
        });
        expect(decrypted.resume).toBeUndefined();
        cb?.({ ok: true, result: encodeBase64Rpc(encrypt(dek, 'dataKey', { ok: true }), 'base64') });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
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

  it('returns a session_run_send JSON envelope', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();
    let sentRequest: any = null;

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
      const dek = new Uint8Array(32).fill(3);
      const socket = createApiSessionSocketStub({
        emit: (event: string, args: unknown[]) => {
          const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
          if (event !== SOCKET_RPC_EVENTS.CALL) return;
          expect(String(data.method ?? '')).toBe(`sess_integration_run_send_123:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}`);
          const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
          sentRequest = decrypt(dek, 'dataKey', decodedParams) as any;
          cb?.({ ok: true, result: encodeBase64Rpc(encrypt(dek, 'dataKey', { ok: true }), 'base64') });
        },
      });
      bindApiSessionSocketMock(mockIo, socket);

      await handleSessionCommand(['run', 'send', 'sess_integration_run_send_123', 'run_1', 'hello run', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed), machineKey: machineKeySeed },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_send');
      expect(parsed.data?.sessionId).toBe('sess_integration_run_send_123');
      expect(parsed.data?.runId).toBe('run_1');
      expect(parsed.data?.sent).toBe(true);
      expect(sentRequest).toMatchObject({
        runId: 'run_1',
        message: 'hello run',
        delivery: 'steer_if_supported',
      });
      expect(sentRequest?.resume).toBeUndefined();
    } finally {
      output.restore();
    }
  });

  it('returns a JSON error envelope when the execution run send RPC reports an app-level failure', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();
    let sentRequest: any = null;

    const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    const dek = new Uint8Array(32).fill(3);
    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        expect(String(data.method ?? '')).toBe(`sess_integration_run_send_123:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}`);
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        sentRequest = decrypt(dek, 'dataKey', decodedParams) as any;
        cb?.({
          ok: true,
          result: encodeBase64Rpc(
            encrypt(dek, 'dataKey', {
              ok: false,
              errorCode: 'execution_run_not_allowed',
              error: 'Not running',
            }),
            'base64',
          ),
        });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['run', 'send', 'sess_integration_run_send_123', 'run_1', 'hello run', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed), machineKey: machineKeySeed },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_run_send');
      expect(parsed.error?.code).toBe('execution_run_not_allowed');
      expect(sentRequest).toMatchObject({
        runId: 'run_1',
        message: 'hello run',
        delivery: 'steer_if_supported',
      });
      expect(sentRequest?.resume).toBeUndefined();
    } finally {
      output.restore();
    }
  });

  it('forwards resume=true when the direct cli wrapper requests a resumed send', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();
    let sentRequest: any = null;

    const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    const dek = new Uint8Array(32).fill(3);
    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        expect(String(data.method ?? '')).toBe(`sess_integration_run_send_123:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}`);
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        sentRequest = decrypt(dek, 'dataKey', decodedParams) as any;
        cb?.({ ok: true, result: encodeBase64Rpc(encrypt(dek, 'dataKey', { ok: true }), 'base64') });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['run', 'send', 'sess_integration_run_send_123', 'run_1', 'hello run', '--resume', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: { type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed), machineKey: machineKeySeed },
          }),
        },
      );

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_send');
      expect(sentRequest).toMatchObject({
        runId: 'run_1',
        message: 'hello run',
        resume: true,
        delivery: 'steer_if_supported',
      });
    } finally {
      output.restore();
    }
  });
});
