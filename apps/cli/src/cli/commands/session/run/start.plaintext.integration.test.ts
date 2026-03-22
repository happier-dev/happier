import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session run start (plaintext integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-run-start-plain-');

    const sessionId = 'sess_integration_run_start_plain_123';
    const metadataPlain = JSON.stringify({ path: '/tmp', flavor: 'claude' });

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const session = {
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 0,
        encryptionMode: 'plain',
        metadata: metadataPlain,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        share: null,
      };

      if (req.method === 'GET' && url.pathname === `/v2/sessions`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sessions: [session], nextCursor: null, hasNext: false }));
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
        res.end(JSON.stringify({ session }));
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

    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((value: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        expect(data.params).toMatchObject({
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        });
        cb?.({ ok: true, result: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' } });
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
      await handleSessionCommand(
        ['run', 'start', 'sess_integration_run_start_plain_123', '--intent', 'review', '--backend', 'claude', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'legacy',
              secret: new Uint8Array(32).fill(8),
            },
          }),
        },
      );

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_start');
      expect(parsed.data?.sessionId).toBe('sess_integration_run_start_plain_123');
      expect(parsed.data?.runId).toBe('run_1');
      expect(parsed.data?.callId).toBe('call_1');
      expect(parsed.data?.backendId).toBe('claude');
      expect(parsed.data?.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    } finally {
      output.restore();
    }
  });
});
