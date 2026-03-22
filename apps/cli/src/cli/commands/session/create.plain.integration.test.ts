import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { clearDaemonState, writeDaemonState } from '@/persistence';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session create plaintext sessions (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-create-plain-');

    const sessionId = 'sess_integration_create_plain_123';
    let metadataJson = JSON.stringify({ path: process.cwd(), host: 'spawn-host' });
    let metadataVersion = 0;
    let observedSpawnBody: Record<string, unknown> | null = null;

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
              metadata: metadataJson,
              metadataVersion,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: null,
              encryptionMode: 'plain',
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

    writeDaemonState({
      pid: process.pid,
      httpPort: address.port,
      startedAt: Date.now(),
      startedWithCliVersion: 'test',
      controlToken: 'test-token',
    });

    const socket = createApiSessionSocketStub({
      emit: async (event: string, args: unknown[]) => {
        if (event !== 'update-metadata') return;
        const [data, callback] = args as [any, ((value: unknown) => void) | undefined];
        const decrypted = JSON.parse(String(data?.metadata ?? '{}'));
        expect(decrypted?.summary?.text).toBe('My Title');
        expect(decrypted?.tag).toBe('MyTag');
        expect(observedSpawnBody).toEqual({
          directory: process.cwd(),
          backendTarget: { kind: 'builtInAgent', agentId: DEFAULT_CATALOG_AGENT_ID },
        });
        metadataJson = String(data.metadata);
        metadataVersion = 1;
        callback?.({ result: 'success', version: metadataVersion, metadata: metadataJson });
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

  it('returns a spawned plaintext session summary when metadata updates stay plaintext', async () => {
    const { handleSessionCommand } = await import('./index');

    const machineKeySeed = new Uint8Array(32).fill(8);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--tag', 'MyTag', '--title', 'My Title', '--json'], {
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
      expect(parsed.data?.session?.id).toBe('sess_integration_create_plain_123');
      expect(parsed.data?.session?.tag).toBe('MyTag');
      expect(parsed.data?.session?.title).toBe('My Title');
      expect(parsed.data?.session?.active).toBe(true);
      expect(parsed.data?.session?.encryptionMode).toBe('plain');
    } finally {
      output.restore();
    }
  });
});
