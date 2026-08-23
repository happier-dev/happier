import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DEFAULT_CATALOG_AGENT_ID } from '@/agent/catalog/ids';
import {
  bindApiSessionSocketMock,
  createAvailableSessionSpawnMachineSnapshot,
  createApiSessionSocketStub,
  respondToExactMachineSessionSpawnRpc,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';

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
  let observedMetadataUpdateCallCount = 0;
  let observedSpawnBody: Record<string, unknown> | null = null;

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-create-plain-');
    observedMetadataUpdateCallCount = 0;
    observedSpawnBody = null;

    const sessionId = 'sess_integration_create_plain_123';
    let metadataJson = JSON.stringify({ path: process.cwd(), host: 'spawn-host' });
    let metadataVersion = 0;
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === '/v1/machines/machine_integration') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ machine: createAvailableSessionSpawnMachineSnapshot('machine_integration') }));
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
          mode: 'plain',
          version: 1,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
          updatedAt: 1,
        }));
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
      emit: (event: string, args: unknown[]) => {
        if (respondToExactMachineSessionSpawnRpc({
          event,
          args,
          machineId: 'machine_integration',
          sessionId,
          onSpawnRequest: (request) => {
            observedSpawnBody = { ...request };
            metadataJson = JSON.stringify({
              path: process.cwd(),
              host: 'spawn-host',
              sessionCreationCorrespondenceV1: request.sessionCreationCorrespondence,
            });
          },
        })) {
          return;
        }

        if (event !== 'update-metadata') return;
        const [data, callback] = args as [any, ((value: unknown) => void) | undefined];
        observedMetadataUpdateCallCount += 1;
        expect(data?.expectedVersion).toBe(metadataVersion);
        const decrypted = JSON.parse(String(data?.metadata ?? '{}'));
        expect(decrypted?.tag).toBeUndefined();
        if (decrypted?.summary !== undefined) {
          expect(decrypted?.summary?.text).toBe('My Title');
        }
        metadataJson = String(data.metadata);
        metadataVersion += 1;
        callback?.({ result: 'success', version: metadataVersion, metadata: metadataJson });
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
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

  it('returns the spawned plaintext session envelope through exact-machine dispatch', async () => {
    const { handleSessionCommand } = await import('./index');

    const machineKeySeed = new Uint8Array(32).fill(8);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['create', '--machine-id', 'machine_integration', '--title', 'My Title', '--json'], {
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
      expect(observedSpawnBody).toEqual(expect.objectContaining({
        directory: process.cwd(),
        machineId: 'machine_integration',
        backendTarget: { kind: 'backend', backendId: DEFAULT_CATALOG_AGENT_ID, sourceKind: 'built_in' },
        initialTitle: 'My Title',
        spawnNonce: expect.any(String),
      }));
      expect(observedMetadataUpdateCallCount).toBe(0);
    } finally {
      output.restore();
    }
  });
});
