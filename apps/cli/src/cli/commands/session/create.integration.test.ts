import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { clearDaemonState, writeDaemonState } from '@/persistence';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session create (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let machineKeySeed: Uint8Array;
  let observedInitialMessageRpc = false;
  let observedSpawnBody: Record<string, unknown> | null = null;

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
    observedInitialMessageRpc = false;
    observedSpawnBody = null;

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'POST' && url.pathname === `/spawn-session`) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        observedSpawnBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, sessionId }));
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

    const socket = createApiSessionSocketStub({
      emit: async (event: string, args: unknown[]) => {
        if (event === 'update-metadata') {
          const [data, callback] = args as [any, ((value: unknown) => void) | undefined];
          const decrypted = decryptWithDataKey(decodeBase64(String(data?.metadata ?? ''), 'base64'), dek);
          expect(decrypted?.summary?.text).toBe('My Title');
          expect(decrypted?.tag).toBe('MyTag');
          metadataCiphertext = String(data.metadata);
          metadataVersion = 1;
          callback?.({ result: 'success', version: metadataVersion, metadata: metadataCiphertext });
          return;
        }

        if (event === SOCKET_RPC_EVENTS.CALL) {
          const [, callback] = args as [any, ((value: unknown) => void) | undefined];
          observedInitialMessageRpc = true;
          callback?.({ ok: true });
          return;
        }

        if (event === 'message') {
          const [, callback] = args as [any, ((value: unknown) => void) | undefined];
          callback?.({ ok: true, id: 'm1', seq: 1, localId: 'local-1' });
          return;
        }
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
  });

  afterEach(async () => {
    await clearDaemonState();
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

  it('returns a session_create JSON envelope and marks created=true when tag does not exist', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--tag', 'MyTag', '--title', 'My Title', '--prompt', 'Plan the refactor', '--json'], {
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
      expect(parsed.data?.session?.tag).toBe('MyTag');
      expect(parsed.data?.session?.title).toBe('My Title');
      expect(parsed.data?.session?.active).toBe(true);
      expect(parsed.data?.session?.encryption?.type).toBe('dataKey');
      expect(observedSpawnBody).toEqual({
        directory: process.cwd(),
        backendTarget: { kind: 'builtInAgent', agentId: DEFAULT_CATALOG_AGENT_ID },
        initialPrompt: 'Plan the refactor',
      });
      expect(observedInitialMessageRpc).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('accepts --message as an alias for the initial prompt', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--tag', 'MyTag', '--title', 'My Title', '--message', 'Plan the refactor', '--json'], {
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
      expect(observedSpawnBody).toEqual({
        directory: process.cwd(),
        backendTarget: { kind: 'builtInAgent', agentId: DEFAULT_CATALOG_AGENT_ID },
        initialPrompt: 'Plan the refactor',
      });
      expect(observedInitialMessageRpc).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('accepts legacy --no-load-existing flag (ignored)', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--tag', 'MyTag', '--title', 'My Title', '--no-load-existing', '--json'], {
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
      expect(observedSpawnBody).toEqual({
        directory: process.cwd(),
        backendTarget: { kind: 'builtInAgent', agentId: DEFAULT_CATALOG_AGENT_ID },
      });
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
        'Usage: happier session create [--path <path>] [--backend <backend-target>] [--title <text>] [--tag <tag>] [--prompt <text>|--message <text>] [--json]',
      );
    } finally {
      output.restore();
    }
  });
});
