import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { DEFAULT_CATALOG_AGENT_ID } from '@/agent/catalog/ids';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
  bindApiSessionSocketMock,
  createAvailableSessionSpawnMachineSnapshot,
  createApiSessionSocketStub,
  respondToExactMachineSessionSpawnRpc,
  type ApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session create (integration)', () => {
  const envKeys = [
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_HOME_DIR',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let machineKeySeed: Uint8Array;
  let observedInitialMessageAdmission = false;
  let observedSpawnBody: Record<string, unknown> | null = null;
  let observedMetadataUpdateCallCount = 0;
  let sessionGetAttempts = 0;
  let sessionGetNotFoundUntil = 0;
  let sessionSocket: ApiSessionSocketStub;

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-create-');

    const sessionId = 'sess_integration_create_123';
    machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const dek = new Uint8Array(32).fill(3);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });
    const { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } = await import('@/api/encryption');

    let metadataCiphertext = encodeBase64(
      encryptWithDataKey({ path: process.cwd(), host: 'spawn-host' }, dek),
      'base64',
    );
    let metadataVersion = 0;
    observedInitialMessageAdmission = false;
    observedSpawnBody = null;
    observedMetadataUpdateCallCount = 0;
    sessionGetAttempts = 0;
    sessionGetNotFoundUntil = 0;

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === '/v1/machines/machine_integration') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          machine: createAvailableSessionSpawnMachineSnapshot('machine_integration', {
            dataEncryptionKey: encodeBase64(envelope, 'base64'),
          }),
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v2/sessions/lookup-by-tags') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/account/encryption/currentness') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          mode: 'e2ee',
          version: 1,
          signingKeyFingerprint: 'integration-signing-key',
          contentKeyFingerprint: 'integration-content-key',
          updatedAt: 1,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        sessionGetAttempts += 1;
        if (sessionGetAttempts <= sessionGetNotFoundUntil) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'Not found', path: url.pathname, message: 'Not found' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: true,
              activeAt: 2,
              archivedAt: null,
              metadata: metadataCiphertext,
              metadataVersion,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: encodeBase64(envelope, 'base64'),
              share: null,
            }
          }),
        );
        return;
      }

      if (req.method === 'PATCH' && url.pathname === `/v2/sessions/${sessionId}`) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          metadata?: { ciphertext?: unknown; expectedVersion?: unknown };
        };
        const metadata = body.metadata;
        if (!metadata || typeof metadata.ciphertext !== 'string' || metadata.expectedVersion !== metadataVersion) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            success: false,
            error: 'version-mismatch',
            metadata: { version: metadataVersion, value: metadataCiphertext },
          }));
          return;
        }

        const decrypted = decryptWithDataKey(decodeBase64(metadata.ciphertext, 'base64'), dek);
        if (decrypted?.summary !== undefined) {
          expect(decrypted?.summary?.text).toBe('My Title');
        }
        expect(decrypted?.tag).toBeUndefined();
        metadataCiphertext = metadata.ciphertext;
        metadataVersion += 1;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, metadata: { version: metadataVersion } }));
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

    writeDaemonState({
      pid: process.pid,
      httpPort: address.port,
      startedAt: Date.now(),
      startedWithCliVersion: 'test',
      controlToken: 'test-token',
    });

    sessionSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        if (respondToExactMachineSessionSpawnRpc({
          event,
          args,
          machineId: 'machine_integration',
          sessionId,
          rpcCodec: {
            decode: (value) => decryptWithDataKey(decodeBase64(String(value), 'base64'), machineKeySeed),
            encode: (value) => encodeBase64(encryptWithDataKey(value, machineKeySeed), 'base64'),
          },
          onSpawnRequest: (request) => {
            observedSpawnBody = { ...request };
            metadataCiphertext = encodeBase64(
              encryptWithDataKey({
                path: process.cwd(),
                host: 'spawn-host',
                sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence,
              }, dek),
              'base64',
            );
          },
        })) {
          return;
        }

        if (event === 'update-metadata') {
          const [data, callback] = args as [any, ((value: unknown) => void) | undefined];
          observedMetadataUpdateCallCount += 1;
          expect(data?.expectedVersion).toBe(metadataVersion);
          const decrypted = decryptWithDataKey(decodeBase64(String(data?.metadata ?? ''), 'base64'), dek);
          expect(decrypted?.tag).toBeUndefined();
          if (decrypted?.summary !== undefined) {
            expect(decrypted?.summary?.text).toBe('My Title');
          }
          metadataCiphertext = String(data.metadata);
          metadataVersion += 1;
          callback?.({ result: 'success', version: metadataVersion, metadata: metadataCiphertext });
          return;
        }

        if (event === SOCKET_RPC_EVENTS.CALL) {
          const [, callback] = args as [any, ((value: unknown) => void) | undefined];
          callback?.({ ok: true });
          return;
        }

        if (event === 'message') {
          const [, callback] = args as [any, ((value: unknown) => void) | undefined];
          observedInitialMessageAdmission = true;
          callback?.({ ok: true, id: 'm1', seq: 1, localId: 'local-1' });
          return;
        }
      },
    });
    bindApiSessionSocketMock(mockIo, sessionSocket);
  });

  afterEach(async () => {
    await clearDaemonStateForTestTeardown();
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

  it('returns a session_create JSON envelope and marks created=true', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--title', 'My Title', '--prompt', 'Plan the refactor', '--json'], {
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
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_create');
      expect(parsed.data?.created).toBe(true);
      expect(parsed.data?.session?.id).toBe('sess_integration_create_123');
      expect(observedSpawnBody).toEqual(expect.objectContaining({
        directory: process.cwd(),
        machineId: 'machine_integration',
        backendTarget: { kind: 'backend', backendId: DEFAULT_CATALOG_AGENT_ID, sourceKind: 'built_in' },
        initialTitle: 'My Title',
        spawnNonce: expect.any(String),
      }));
      expect(observedInitialMessageAdmission).toBe(false);
      expect(observedMetadataUpdateCallCount).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('retries fetching the spawned session until it becomes visible on the server', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();
    sessionGetNotFoundUntil = 1;

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--title', 'My Title', '--prompt', 'Plan the refactor', '--json'], {
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
      expect(parsed.kind).toBe('session_create');
      expect(parsed.data?.session?.id).toBe('sess_integration_create_123');
      expect(sessionGetAttempts).toBeGreaterThan(1);
      expect(observedMetadataUpdateCallCount).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('carries the create-time title through the exact-machine spawn request', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--title', 'My Title', '--prompt', 'Plan the refactor', '--json'], {
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
      expect(parsed.kind).toBe('session_create');
      expect(parsed.data?.session?.id).toBe('sess_integration_create_123');
      expect(observedSpawnBody).toEqual(expect.objectContaining({ initialTitle: 'My Title' }));
      expect(observedMetadataUpdateCallCount).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('accepts --message as an alias for the initial prompt', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--title', 'My Title', '--message', 'Plan the refactor', '--json'], {
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
      expect(parsed.kind).toBe('session_create');
      expect(observedSpawnBody).toEqual(expect.objectContaining({
        directory: process.cwd(),
        machineId: 'machine_integration',
        backendTarget: { kind: 'backend', backendId: DEFAULT_CATALOG_AGENT_ID, sourceKind: 'built_in' },
        initialTitle: 'My Title',
        spawnNonce: expect.any(String),
      }));
      expect(observedInitialMessageAdmission).toBe(false);
      expect(observedMetadataUpdateCallCount).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('accepts --agent as a single-target alias for the spawned backend target', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--agent', 'codex', '--prompt', 'Plan the refactor', '--json'], {
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
      expect(parsed.kind).toBe('session_create');
      expect(observedSpawnBody).toEqual(expect.objectContaining({
        directory: process.cwd(),
        machineId: 'machine_integration',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        spawnNonce: expect.any(String),
      }));
      expect(observedInitialMessageAdmission).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('rejects the obsolete --no-load-existing flag before spawning', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--title', 'My Title', '--no-load-existing', '--json'], {
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
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_create');
      expect(parsed.error?.code).toBe('invalid_arguments');
      expect(observedSpawnBody).toBeNull();
      expect(observedMetadataUpdateCallCount).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('rejects multi-backend csv input for the single-target create wrapper', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--backend', 'claude,codex', '--json'], {
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
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_create');
      expect(parsed.error?.code).toBe('invalid_arguments');
      expect(parsed.error?.message).toBe(
        `Usage: ${SESSION_HELP_LINES.create}`,
      );
    } finally {
      output.restore();
    }
  });
});
