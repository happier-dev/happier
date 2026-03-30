import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
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

describe('happier session status (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let idleAgentStateCiphertext = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-status-');

    const sessionId = 'sess_integration_status_123';
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
          tag: 'MyTag',
          host: 'host1',
        },
        dek,
      ),
      'base64',
    );
    const agentStateCiphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          controlledByUser: false,
          requests: { r1: { type: 'tool', createdAt: 1 } },
        },
        dek,
      ),
      'base64',
    );
    idleAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          controlledByUser: false,
          requests: {},
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
              agentState: agentStateCiphertext,
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

    const socket = createApiSessionSocketStub({
      onConnect(currentSocket) {
        setTimeout(() => {
          currentSocket.trigger('update', {
            id: 'u1',
            seq: 2,
            createdAt: Date.now(),
            body: {
              t: 'update-session',
              id: 'sess_integration_status_123',
              agentState: { value: idleAgentStateCiphertext, version: 1 },
            },
          });
        }, 10);
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

  it('returns a session_status JSON envelope with agentState summary', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['status', 'sess_integration_status_123', '--json'], {
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
      expect(parsed.kind).toBe('session_status');
      expect(parsed.data?.session?.id).toBe('sess_integration_status_123');
      expect(parsed.data?.agentState?.pendingRequestsCount).toBe(1);
      expect(parsed.data?.agentState?.controlledByUser).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('supports --live and prefers the latest agentState from socket updates', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['status', 'sess_integration_status_123', '--live', '--json'], {
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
      expect(parsed.kind).toBe('session_status');
      expect(parsed.data?.agentState?.pendingRequestsCount).toBe(0);
    } finally {
      output.restore();
    }
  });
});
