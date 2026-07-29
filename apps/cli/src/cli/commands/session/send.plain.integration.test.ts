import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  bindApiSessionSocketMock,
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
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
  let sessionActive = true;
  let sessionActiveAt = 2;
  let latestTurnStatus: 'in_progress' | 'completed' = 'completed';
  let latestTurnStatusObservedAt = 1;
  let visibleMessageByLocalId: {
    id: string;
    localId: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    content: unknown;
  } | null = null;
  let transcriptMessages: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-send-plain-');
    receivedMessages.length = 0;
    sessionActive = true;
    sessionActiveAt = 2;
    latestTurnStatus = 'completed';
    latestTurnStatusObservedAt = 1;
    visibleMessageByLocalId = null;
    transcriptMessages = [];

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
              active: sessionActive,
              activeAt: sessionActiveAt,
              metadata: metadataPlain,
              metadataVersion: 0,
              agentState: JSON.stringify({ controlledByUser: false, requests: {} }),
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              latestTurnStatus,
              latestTurnStatusObservedAt,
              pendingPermissionRequestCount: 0,
              pendingUserActionRequestCount: 0,
              dataEncryptionKey: null,
              encryptionMode: 'plain',
              share: null,
            },
          }),
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === `/v2/sessions/${sessionId}/pending`) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          localId: string;
          content: { t: 'plain'; v: unknown };
        };
        receivedMessages.push(body.content);
        const createdAt = Date.now();
        visibleMessageByLocalId = {
          id: `msg-${body.localId}`,
          localId: body.localId,
          seq: 4,
          createdAt,
          updatedAt: createdAt,
          content: body.content,
        };
        transcriptMessages = [visibleMessageByLocalId];

        const promptText =
          body.content?.t === 'plain'
          && body.content.v
          && typeof body.content.v === 'object'
          && !Array.isArray(body.content.v)
          && (body.content.v as { content?: unknown }).content
          && typeof (body.content.v as { content: unknown }).content === 'object'
          && !Array.isArray((body.content.v as { content: unknown }).content)
            ? String(((body.content.v as { content: { text?: unknown } }).content.text) ?? '')
            : '';
        if (promptText === 'Wait for fast native response') {
          transcriptMessages.push({
            id: 'msg-fast-native-assistant',
            localId: null,
            seq: 5,
            createdAt: createdAt + 1,
            updatedAt: createdAt + 1,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: {
                  type: 'acp',
                  agentId: 'agent',
                  data: { type: 'text', text: 'PLAIN_FAST_READY' },
                },
              },
            },
          });
          latestTurnStatus = 'completed';
          latestTurnStatusObservedAt = createdAt + 1;
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ didWrite: true, terminal: false, suppressed: false }));
        return;
      }

      const lookupPrefix = `/v2/sessions/${sessionId}/messages/by-local-id/`;
      if (req.method === 'GET' && url.pathname.startsWith(lookupPrefix)) {
        const localId = decodeURIComponent(url.pathname.slice(lookupPrefix.length));
        if (!visibleMessageByLocalId || visibleMessageByLocalId.localId !== localId) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: visibleMessageByLocalId }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        const afterSeqRaw = url.searchParams.get('afterSeq');
        const afterSeq = afterSeqRaw === null ? null : Number.parseInt(afterSeqRaw, 10);
        const rows = afterSeq === null || !Number.isFinite(afterSeq)
          ? transcriptMessages
          : transcriptMessages.filter((message) => (
              typeof message.seq === 'number' && message.seq > afterSeq
            ));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: rows }));
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

  it('enqueues a plaintext message envelope and includes meta defaults from plaintext metadata', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();
    const rpcSocket = createApiSessionSocketStub();
    rpcSocket.connect = vi.fn(() => {
      rpcSocket.trigger('connect_error', new Error('connect_error'));
      return rpcSocket;
    });
    const committedSocket = createApiSessionSocketStub({
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
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, committedSocket]);

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
      expect(last?.v?.meta).not.toHaveProperty('model');
    } finally {
      output.restore();
    }
  });

  it('completes --wait when native assistant text and the terminal projection arrive before socket subscription', async () => {
    const { handleSessionCommand } = await import('./index');
    latestTurnStatus = 'in_progress';
    latestTurnStatusObservedAt = Date.now();

    const output = captureConsoleJsonOutput();
    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        [
          'send',
          'sess_integration_send_plain_123',
          'Wait for fast native response',
          '--wait',
          '--timeout',
          '1',
          '--json',
        ],
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

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'session_send',
        data: {
          sessionId: 'sess_integration_send_plain_123',
          waited: true,
        },
      });
      expect(transcriptMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          seq: 5,
          content: expect.objectContaining({
            v: expect.objectContaining({
              content: expect.objectContaining({
                data: { type: 'text', text: 'PLAIN_FAST_READY' },
              }),
            }),
          }),
        }),
      ]));
    } finally {
      output.restore();
    }
  });
});
