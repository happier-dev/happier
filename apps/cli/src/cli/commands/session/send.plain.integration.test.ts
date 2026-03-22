import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session send plaintext sessions (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  const receivedMessages: any[] = [];

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-send-plain-');
    receivedMessages.length = 0;

    const sessionId = 'sess_integration_send_plain_123';
    const metadataPlain = JSON.stringify({
      path: '/tmp',
      tag: 'MyTag',
      host: 'host1',
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 10,
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'claude-sonnet-4-0' },
    });

    server = createServer(async (req, res) => {
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
              metadata: metadataPlain,
              metadataVersion: 0,
              agentState: JSON.stringify({ controlledByUser: false, requests: {} }),
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
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [payload, ack] = args as [any, ((answer: any) => void) | undefined];
        if (event === 'message') {
          receivedMessages.push(payload?.message);
          ack?.({ ok: true, id: 'm1', seq: 2, localId: payload?.localId ?? null, didWrite: true });
          return;
        }
        ack?.({ ok: false, error: 'unsupported' });
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

  it('emits a plaintext message envelope over the socket and includes meta defaults from plaintext metadata', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['send', 'sess_integration_send_plain_123', 'Hello from controller', '--json'], {
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
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');

      const last = receivedMessages[receivedMessages.length - 1];
      expect(last?.t).toBe('plain');
      expect(last?.v?.content?.text).toBe('Hello from controller');
      expect(last?.v?.meta?.permissionMode).toBe('safe-yolo');
      expect(last?.v?.meta?.model).toBe('claude-sonnet-4-0');
    } finally {
      output.restore();
    }
  });
});
