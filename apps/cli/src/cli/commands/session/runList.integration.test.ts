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
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session run list (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-run-list-');

    const sessionId = 'sess_integration_ctrl_123';
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
      encryptWithDataKey(
        {
          path: '/tmp/happier-session-control-integration',
          flavor: 'claude',
        },
        dek,
      ),
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

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve session control integration test server address');
    }
    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    const socket = createApiSessionSocketStub({
      connected: true,
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const decodedParams = decodeBase64(String(data.params ?? ''));
        const decrypted = decrypt(dek, 'dataKey', decodedParams) as any;
        if (typeof decrypted !== 'object' || decrypted == null) {
          cb?.({ ok: false, error: 'invalid params' });
          return;
        }

        const resultPayload = {
          runs: [
            {
              runId: 'run_1',
              callId: 'call_1',
              sidechainId: 'call_1',
              intent: 'review',
              backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
              permissionMode: 'read_only',
              retentionPolicy: 'ephemeral',
              runClass: 'bounded',
              ioMode: 'request_response',
              status: 'succeeded',
              startedAtMs: 1,
              finishedAtMs: 2,
            },
          ],
        };
        const encryptedResult = encodeBase64Rpc(encrypt(dek, 'dataKey', resultPayload), 'base64');
        cb?.({ ok: true, result: encryptedResult });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
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

  it('returns session_run_list JSON envelope', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['run', 'list', 'sess_integration_ctrl_123', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_list');
      expect(parsed.data?.sessionId).toBe('sess_integration_ctrl_123');
      expect(parsed.data?.runs?.[0]?.runId).toBe('run_1');
    } finally {
      output.restore();
    }
  });

  it('forwards backend, status, and limit filters from the direct cli wrapper', async () => {
    const { handleSessionCommand } = await import('./index');

    const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    const dek = new Uint8Array(32).fill(3);
    const socket = createApiSessionSocketStub({
      connected: true,
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const decodedParams = decodeBase64(String(data.params ?? ''));
        const decrypted = decrypt(dek, 'dataKey', decodedParams) as any;
        expect(decrypted).toMatchObject({
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          status: 'running',
          limit: 1,
        });
        const encryptedResult = encodeBase64Rpc(encrypt(dek, 'dataKey', { runs: [] }), 'base64');
        cb?.({ ok: true, result: encryptedResult });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(
        ['run', 'list', 'sess_integration_ctrl_123', '--backend', 'claude', '--status', 'running', '--limit', '1', '--json'],
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
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_list');
    } finally {
      output.restore();
    }
  });

  it('rejects multi-backend csv input for the single-target run list filter', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(
        ['run', 'list', 'sess_integration_ctrl_123', '--backend', 'claude,codex', '--json'],
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
      expect(parsed.kind).toBe('session_run_list');
      expect(parsed.error?.code).toBe('invalid_arguments');
      expect(parsed.error?.message).toBe('Usage: happier session run list <session-id-or-prefix> [--backend <backend-target>] [--status <status>] [--limit <count>] [--json]');
    } finally {
      output.restore();
    }
  });

  it('merges daemon marker runs when session RPC returns an empty list', async () => {
    const { handleSessionCommand } = await import('./index');
    const { writeExecutionRunMarker } = await import('@/daemon/executionRunRegistry');

    await writeExecutionRunMarker({
      pid: 123,
      happySessionId: 'sess_integration_ctrl_123',
      runId: 'run_marker_visible',
      callId: 'call_marker_visible',
      sidechainId: 'call_marker_visible',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      permissionMode: 'workspace_write',
      runClass: 'long_lived',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'running',
      startedAtMs: 20,
      updatedAtMs: 21,
    });
    await writeExecutionRunMarker({
      pid: 124,
      happySessionId: 'sess_other',
      runId: 'run_marker_hidden',
      callId: 'call_marker_hidden',
      sidechainId: 'call_marker_hidden',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'workspace_write',
      runClass: 'long_lived',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      status: 'running',
      startedAtMs: 30,
      updatedAtMs: 31,
    });

    const { encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    const socket = createApiSessionSocketStub({
      connected: true,
      emit: (event: string, args: unknown[]) => {
        const [_data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        const encryptedResult = encodeBase64Rpc(encrypt(new Uint8Array(32).fill(3), 'dataKey', { runs: [] }), 'base64');
        cb?.({ ok: true, result: encryptedResult });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['run', 'list', 'sess_integration_ctrl_123', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_list');
      expect(parsed.data?.runs).toHaveLength(1);
      expect(parsed.data?.runs?.[0]?.runId).toBe('run_marker_visible');
      expect(parsed.data?.runs?.[0]?.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'opencode' });
    } finally {
      output.restore();
    }
  });
});
