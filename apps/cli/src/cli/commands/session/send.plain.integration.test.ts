import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  bindApiSessionSocketMock,
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import { buildSessionStopHoldV1, type SessionExplicitStopV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

const { mockIo, openSessionDataEncryptionKeySpy } = vi.hoisted(() => ({
  mockIo: vi.fn(),
  openSessionDataEncryptionKeySpy: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('@/api/client/openSessionDataEncryptionKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client/openSessionDataEncryptionKey')>();
  return {
    ...actual,
    openSessionDataEncryptionKey: (
      ...args: Parameters<typeof actual.openSessionDataEncryptionKey>
    ) => {
      openSessionDataEncryptionKeySpy(...args);
      return actual.openSessionDataEncryptionKey(...args);
    },
  };
});

describe('happier session send plaintext sessions (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  const receivedMessages: any[] = [];
  let sessionActive = true;
  let explicitStop: SessionExplicitStopV1 | null = null;
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
  let currentnessFailure: '503' | 'reset' | '401' | 'invalid' | 'migration' | null = null;
  const mutationPaths: string[] = [];
  const machineReadPaths: string[] = [];

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-send-plain-');
    receivedMessages.length = 0;
    sessionActive = true;
    explicitStop = null;
    sessionActiveAt = 2;
    latestTurnStatus = 'completed';
    latestTurnStatusObservedAt = 1;
    visibleMessageByLocalId = null;
    transcriptMessages = [];
    currentnessFailure = null;
    mutationPaths.length = 0;
    machineReadPaths.length = 0;
    mockIo.mockClear();
    openSessionDataEncryptionKeySpy.mockClear();

    const sessionId = 'sess_integration_send_plain_123';
    const metadataPlain = () => JSON.stringify({
      path: '/tmp',
      tag: 'MyTag',
      host: 'host1',
      // Every Session the daemon creates records its Agent identity, and the
      // shared testkit metadata does the same (`testkit/backends/sessionMetadata.ts:11`).
      // Without it `resolveAgentIdFromSessionMetadata` answers null and the
      // persisted model intent below correctly fails closed
      // (`resolveSessionMessageModel.ts:110-113`).
      flavor: 'claude',
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 10,
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'claude-sonnet-4-0' },
      ...(explicitStop ? { machineId: 'machine-1', claudeSessionId: 'native-session', sessionExplicitStopV1: explicitStop } : {}),
    });

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method !== 'GET') mutationPaths.push(url.pathname);
      if (url.pathname.includes('/machines')) machineReadPaths.push(url.pathname);

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
              metadata: metadataPlain(),
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

      // Every owner-authority session snapshot refresh reads Account encryption
      // currentness (`sessionClient.ts:983,1984`), plaintext Sessions included,
      // so the integration server has to answer that boundary or the send fails
      // closed with `Account encryption currentness is unavailable (404)`.
      if (req.method === 'GET' && url.pathname === '/v1/account/encryption/currentness') {
        if (currentnessFailure === 'reset') {
          req.socket.destroy();
          return;
        }
        if (currentnessFailure !== null) {
          res.statusCode = currentnessFailure === 'invalid' ? 200
            : currentnessFailure === 'migration' ? 400 : Number(currentnessFailure);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(currentnessFailure === 'migration'
            ? { error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_inconsistent' } }
            : { error: 'fixture failure; private upstream details' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(createAccountEncryptionCurrentnessFixture({ mode: 'plain' })));
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

  it.each([
    ['503', 'server_unreachable'],
    ['reset', 'server_unreachable'],
    ['401', 'not_authenticated'],
    ['invalid', 'unknown_error'],
    ['migration', 'unknown_error'],
  ] as const)('fails before input admission for currentness %s and accepts one explicit retry', async (failure, code) => {
    const { handleSessionCommand } = await import('./index');
    const localId = `currentness-recovery-${failure}`;
    const argv = ['send', 'sess_integration_send_plain_123', 'Retry after Home recovery', '--local-id', localId, '--json'];
    const deps = { readCredentialsFn: async () => ({ token: 'token_test', encryption: null }) };
    const previousExitCode = process.exitCode;
    const output = captureConsoleJsonOutput();
    try {
      sessionActive = false;
      currentnessFailure = failure;
      await handleSessionCommand(argv, deps);
      const result = output.json();
      expect(result).toMatchObject({ ok: false, kind: 'session_send', error: { code } });
      expect(JSON.stringify(result)).not.toContain('private upstream details');
      if (failure === 'invalid') expect(result.error?.message).toContain('response is invalid');
      if (failure === 'migration') expect(result.error?.message).toContain('(400)');
      expect(receivedMessages).toEqual([]);
      expect(mutationPaths).toEqual([]);
      expect(mockIo).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }

    currentnessFailure = null;
    sessionActive = true;
    const retryOutput = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(argv, deps);
      expect(retryOutput.json()).toMatchObject({ ok: true, data: { localId } });
      expect(receivedMessages).toHaveLength(1);
      expect(visibleMessageByLocalId).toMatchObject({ localId });
      expect(mutationPaths).toEqual([`/v2/sessions/sess_integration_send_plain_123/pending`]);
    } finally {
      retryOutput.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('keeps a terminal Send queued with the hold in place when the resume cannot reach a machine', async () => {
    const { handleSessionCommand } = await import('./index');
    const hold = buildSessionStopHoldV1({ rawSession: { id: 'sess_integration_send_plain_123' },
      stopIntent: 'explicit_stop', executionAuthority: 'present_user', requestId: 'person-stop', requestedAtMs: 1 });
    if (hold.kind !== 'hold') throw new Error('Expected an explicit Stop hold');
    sessionActive = false;
    explicitStop = hold.stop;
    const previousExitCode = process.exitCode;
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', 'sess_integration_send_plain_123', 'An ordinary message',
        '--local-id', 'ordinary-held', '--json'], {
        readCredentialsFn: async () => ({ token: 'token_test', encryption: null }),
      });
      // The public Send result reports durable input admission, not wake or
      // provider consumption. A failed resume leaves it queued and the hold unchanged.
      expect(output.json()).toMatchObject({ ok: true, kind: 'session_send', data: { localId: 'ordinary-held' } });
      expect(visibleMessageByLocalId).toMatchObject({ localId: 'ordinary-held' });
      expect(explicitStop).toEqual(hold.stop);
      expect(mutationPaths).toEqual(['/v2/sessions/sess_integration_send_plain_123/pending']);
      expect(machineReadPaths).toEqual([]);
      expect(mockIo).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
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
      await handleSessionCommand(['send', 'sess_integration_send_plain_123', 'Hello from controller', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: null,
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
      expect(openSessionDataEncryptionKeySpy).not.toHaveBeenCalled();
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
