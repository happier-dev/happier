import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session run start (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-run-start-');

    const sessionId = 'sess_integration_run_start_123';
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
      if (req.method === 'GET' && url.pathname === `/v2/sessions/archived`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }));
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
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        const decrypted = decrypt(dek, 'dataKey', decodedParams) as any;
        expect(decrypted).toMatchObject({
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        });

        const resultPayload = { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' };
        cb?.({
          ok: true,
          result: encodeBase64Rpc(encrypt(dek, 'dataKey', resultPayload), 'base64'),
        });
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

  it('returns a session_run_start JSON envelope', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['run', 'start', 'sess_integration_run_start_123', '--intent', 'review', '--backend', 'claude', '--json'],
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
      expect(parsed.kind).toBe('session_run_start');
      expect(parsed.data?.sessionId).toBe('sess_integration_run_start_123');
      expect(parsed.data?.runId).toBe('run_1');
      expect(parsed.data?.callId).toBe('call_1');
      expect(parsed.data?.backendId).toBe('claude');
      expect(parsed.data?.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    } finally {
      output.restore();
    }
  });

  it('rejects multi-backend csv input for the single-target run start wrapper', async () => {
    const { handleSessionCommand } = await import('../index');
    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(
        ['run', 'start', 'sess_integration_run_start_123', '--intent', 'review', '--backend', 'claude,codex', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'dataKey',
              publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
              machineKey: new Uint8Array(32).fill(8),
            },
          }),
        },
      );

      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_run_start');
      expect(parsed.error?.code).toBe('invalid_arguments');
      expect(parsed.error?.message).toBe('Usage: happier session run start <session-id> --intent <intent> --backend <backend-target> [--json]');
    } finally {
      output.restore();
    }
  });

  it('returns a JSON error envelope when the execution run start RPC reports an app-level failure', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();

    const { encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [_data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        cb?.({
          ok: true,
          result: encodeBase64Rpc(
            encrypt(new Uint8Array(32).fill(3), 'dataKey', {
              ok: false,
              errorCode: 'execution_run_budget_exceeded',
              error: 'Execution run budget exceeded',
            }),
            'base64',
          ),
        });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['run', 'start', 'sess_integration_run_start_123', '--intent', 'review', '--backend', 'claude', '--json'],
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
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_run_start');
      expect(parsed.error?.code).toBe('execution_run_budget_exceeded');
    } finally {
      output.restore();
    }
  });

  it('accepts <session-id-or-prefix>', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['run', 'start', 'sess_inte', '--intent', 'review', '--backend', 'claude', '--json'],
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
      expect(parsed.kind).toBe('session_run_start');
      expect(parsed.data?.sessionId).toBe('sess_integration_run_start_123');
      expect(parsed.data?.backendId).toBe('claude');
      expect(parsed.data?.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    } finally {
      output.restore();
    }
  });

  it('uses long-lived streaming defaults for voice_agent starts', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();

    const socket = createApiSessionSocketStub({
      emit: async (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        const decrypted = decrypt(new Uint8Array(32).fill(3), 'dataKey', decodedParams) as any;
        expect(decrypted).toMatchObject({
          intent: 'voice_agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          runClass: 'long_lived',
          ioMode: 'streaming',
        });

        const resultPayload = { runId: 'run_voice_1', callId: 'call_voice_1', sidechainId: 'call_voice_1' };
        cb?.({
          ok: true,
          result: encodeBase64Rpc(encrypt(new Uint8Array(32).fill(3), 'dataKey', resultPayload), 'base64'),
        });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['run', 'start', 'sess_integration_run_start_123', '--intent', 'voice_agent', '--backend', 'claude', '--json'],
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
      expect(parsed.kind).toBe('session_run_start');
      expect(parsed.data?.runId).toBe('run_voice_1');
      expect(parsed.data?.backendId).toBe('claude');
      expect(parsed.data?.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    } finally {
      output.restore();
    }
  });

  it('preserves configured ACP backend backend targets', async () => {
    const { handleSessionCommand } = await import('../index');

    const output = captureConsoleJsonOutput();

    const socket = createApiSessionSocketStub({
      emit: async (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        const decrypted = decrypt(new Uint8Array(32).fill(3), 'dataKey', decodedParams) as any;
        expect(decrypted).toMatchObject({
          intent: 'delegate',
          backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        });

        const resultPayload = { runId: 'run_custom_1', callId: 'call_custom_1', sidechainId: 'call_custom_1' };
        cb?.({
          ok: true,
          result: encodeBase64Rpc(encrypt(new Uint8Array(32).fill(3), 'dataKey', resultPayload), 'base64'),
        });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['run', 'start', 'sess_integration_run_start_123', '--intent', 'delegate', '--backend', 'acpBackend:review-bot', '--json'],
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
      expect(parsed.kind).toBe('session_run_start');
      expect(parsed.data?.sessionId).toBe('sess_integration_run_start_123');
      expect(parsed.data?.runId).toBe('run_custom_1');
      expect(parsed.data?.backendId).toBe('review-bot');
      expect(parsed.data?.backendTarget).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    } finally {
      output.restore();
    }
  });
});
