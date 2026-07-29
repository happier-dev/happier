import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
  bindApiSessionSocketMock,
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session send (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  const receivedMessages: any[] = [];
  let dek: Uint8Array | null = null;
  let decodeBase64Fn: ((value: string, kind?: any) => Uint8Array) | null = null;
  let decryptWithDataKeyFn: ((ciphertext: Uint8Array, dataKey: Uint8Array) => any) | null = null;
  let sessionActive = false;
  let sessionActiveAt = 0;
  let sessionArchivedAt: number | null = null;
  let sessionMetadataCiphertext = '';
  let sessionAgentStateCiphertext: string | null = null;
  let sessionDataEncryptionKeyBase64 = '';
  let visibleMessageByLocalId: { id: string; localId: string; seq: number; createdAt: number; updatedAt: number; content: any } | null = null;
  let transcriptLookupRequests = 0;
  let transcriptAfterSeqRequests: Array<number | null> = [];
  let transcriptMessages: Array<Record<string, unknown>> = [];
  let lastActiveSessionRpcLocalId: string | null = null;
  let onActiveSessionRpcLocalId: ((localId: string) => void) | null = null;
  let stageCommittedUserMessageInTranscript = false;
  let stageVisibleMessageByLocalIdDelayMs: number | null = null;

  function recordActiveSessionRpcLocalId(value: unknown): void {
    const localId = typeof value === 'string' && value.trim().length > 0 ? value : null;
    lastActiveSessionRpcLocalId = localId;
    if (localId) {
      onActiveSessionRpcLocalId?.(localId);
    }
  }

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-send-');
    receivedMessages.length = 0;
    dek = null;
    decodeBase64Fn = null;
    decryptWithDataKeyFn = null;

    const sessionId = 'sess_integration_send_123';
    dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek!,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');
    decodeBase64Fn = decodeBase64;
    decryptWithDataKeyFn = decryptWithDataKey;
    const metadataCiphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          path: '/tmp',
          tag: 'MyTag',
          host: 'host1',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 10,
          modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'claude-sonnet-4-0' },
        },
        dek!,
      ),
      'base64',
    );
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');
    const busyAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: { r1: { createdAt: 1 } } }, dek!),
      'base64',
    );
    const idleAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: {} }, dek!),
      'base64',
    );
    sessionActive = false;
    sessionActiveAt = 0;
    sessionArchivedAt = null;
    sessionMetadataCiphertext = metadataCiphertext;
    sessionAgentStateCiphertext = busyAgentStateCiphertext;
    sessionDataEncryptionKeyBase64 = dataEncryptionKeyBase64;
    visibleMessageByLocalId = null;
    transcriptLookupRequests = 0;
    transcriptAfterSeqRequests = [];
    transcriptMessages = [];
    lastActiveSessionRpcLocalId = null;
    onActiveSessionRpcLocalId = null;
    stageCommittedUserMessageInTranscript = false;
    stageVisibleMessageByLocalIdDelayMs = null;

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
              archivedAt: sessionArchivedAt,
              metadata: sessionMetadataCiphertext,
              metadataVersion: 0,
              agentState: sessionAgentStateCiphertext,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: sessionDataEncryptionKeyBase64,
              encryptionMode: 'e2ee',
              share: null,
            },
          }),
        );
        return;
      }

      const lookupPrefix = `/v2/sessions/${sessionId}/messages/by-local-id/`;
      if (req.method === 'GET' && url.pathname.startsWith(lookupPrefix)) {
        transcriptLookupRequests += 1;
        const localId = decodeURIComponent(url.pathname.slice(lookupPrefix.length));
        if (!visibleMessageByLocalId || visibleMessageByLocalId.localId !== localId) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'Message not found', path: url.pathname }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          message: visibleMessageByLocalId,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        const afterSeqRaw = url.searchParams.get('afterSeq');
        const limitRaw = url.searchParams.get('limit');
        transcriptAfterSeqRequests.push(
          typeof afterSeqRaw === 'string' && afterSeqRaw.trim().length > 0
            ? Number.parseInt(afterSeqRaw, 10)
            : null,
        );
        const afterSeq =
          typeof afterSeqRaw === 'string' && afterSeqRaw.trim().length > 0
            ? Number.parseInt(afterSeqRaw, 10)
            : null;
        const limit =
          typeof limitRaw === 'string' && limitRaw.trim().length > 0
            ? Number.parseInt(limitRaw, 10)
            : null;
        const filteredMessages = Number.isFinite(afterSeq)
          ? transcriptMessages.filter((message) => {
              const seq = typeof (message as { seq?: unknown }).seq === 'number' ? Number((message as { seq?: unknown }).seq) : NaN;
              return Number.isFinite(seq) && seq > Number(afterSeq);
            })
          : transcriptMessages;
        const limitedMessages = Number.isFinite(limit) && limit! >= 0
          ? filteredMessages.slice(0, limit!)
          : filteredMessages;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: limitedMessages }));
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
      onConnect: (connectedSocket) => {
        setTimeout(() => {
          connectedSocket.trigger('update', {
            id: 'u1',
            seq: 2,
            createdAt: Date.now(),
            body: {
              t: 'update-session',
              id: sessionId,
              agentState: { value: idleAgentStateCiphertext, version: 1 },
            },
          });
        }, 10);
      },
      emit: (event: string, args: unknown[]) => {
        const [payload, ack] = args as [any, ((answer: any) => void) | undefined];
        if (event === 'message') {
          const content = payload?.message;
          const localId = typeof payload?.localId === 'string' ? String(payload.localId) : null;
          if (content?.t === 'encrypted') {
            const decrypted = decryptWithDataKeyFn!(
              decodeBase64Fn!(String(content?.c ?? ''), 'base64'),
              dek!,
            );
            receivedMessages.push(decrypted);
          } else if (content?.t === 'plain') {
            receivedMessages.push(content.v);
          }

          if (stageCommittedUserMessageInTranscript) {
            transcriptMessages.push({
              id: `m${transcriptMessages.length + 1}`,
              seq: transcriptMessages.length + 1,
              localId,
              createdAt: Date.now(),
              content,
            });
          }

          if (localId && typeof stageVisibleMessageByLocalIdDelayMs === 'number') {
            const createdAt = Date.now();
            setTimeout(() => {
              visibleMessageByLocalId = {
                id: `lookup-${localId}`,
                localId,
                seq: 1,
                createdAt,
                updatedAt: createdAt,
                content,
              };
            }, stageVisibleMessageByLocalIdDelayMs);
          } else if (localId && !visibleMessageByLocalId) {
            const createdAt = Date.now();
            visibleMessageByLocalId = {
              id: `lookup-${localId}`,
              localId,
              seq: 1,
              createdAt,
              updatedAt: createdAt,
              content,
            };
          }
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

  it('fails closed for inactive non-wait sends instead of committing storage-only messages', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['send', 'sess_integration_send_123', 'Hello from controller', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_send',
        error: {
          code: 'session_inactive',
          message: 'Session is inactive. Resume it before sending a message.',
        },
      });
      expect(receivedMessages).toHaveLength(0);
    } finally {
      output.restore();
    }
  });

  it('fails closed instead of committing a message to an archived session', async () => {
    sessionArchivedAt = 123;
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['send', 'sess_integration_send_123', 'Hello from controller', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_send',
        error: { code: 'session_archived' },
      });
      expect(receivedMessages).toHaveLength(0);
    } finally {
      output.restore();
    }
  });

  it('fails closed for inactive-session --wait sends instead of materializing storage-only messages', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['send', 'sess_integration_send_123', 'Hello from controller', '--wait', '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_send',
        error: {
          code: 'session_inactive',
          message: 'Session is inactive. Resume it before sending a message.',
        },
      });
      expect(receivedMessages).toHaveLength(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('fails closed for inactive sessions even when a prior user turn is already visible', async () => {
    stageCommittedUserMessageInTranscript = true;
    stageVisibleMessageByLocalIdDelayMs = 50;

    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['send', 'sess_integration_send_123', 'Hello from controller', '--wait', '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
            machineKey: machineKeySeed,
          },
        }),
      });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'session_send',
        error: {
          code: 'session_inactive',
          message: 'Session is inactive. Resume it before sending a message.',
        },
      });
      expect(receivedMessages).toHaveLength(0);
      expect(transcriptLookupRequests).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('surfaces non-timeout wait failures without rewriting them to timeout', async () => {
    const { handleSessionCommand } = await import('./index');

    const machineKeySeed = new Uint8Array(32).fill(8);
    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');
    const sessionId = 'sess_integration_send_123';
    sessionActive = true;
    sessionActiveAt = 2;

    const rpcSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((answer: any) => void) | undefined];
        if (event === SOCKET_RPC_EVENTS.CALL) {
          const decrypted = decryptWithDataKey(
            decodeBase64(String(data.params ?? ''), 'base64'),
            dek!,
          ) as any;
          recordActiveSessionRpcLocalId(decrypted?.localId);
          cb?.({ ok: true, result: encodeBase64Session(encryptWithDataKey({ ok: true }, dek!), 'base64') });
          return;
        }
        throw new Error(`Unexpected socket event: ${event}`);
      },
    });
    const waitSocket = createApiSessionSocketStub();
    waitSocket.connect = vi.fn(() => {
      waitSocket.trigger('connect_error', new Error('wait socket failed'));
      return waitSocket;
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, waitSocket]);

    const output = captureConsoleJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    let releaseLookupTimer: NodeJS.Timeout | null = null;
    try {
      onActiveSessionRpcLocalId = (localId) => {
        releaseLookupTimer = setTimeout(() => {
          visibleMessageByLocalId = {
            id: 'msg-wait-failure-user',
            seq: 6,
            localId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            content: { t: 'encrypted', c: 'ciphertext' },
          };
          transcriptMessages = [
            {
              id: 'msg-wait-failure-user',
              seq: 6,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'Hello from controller' },
                },
              },
            },
          ];
        }, 40);
      };

      await handleSessionCommand(['send', sessionId, 'Hello from controller', '--wait', '--timeout', '1', '--json'], {
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
      expect(parsed.kind).toBe('session_send');
      expect(parsed.error?.code).toBe('wait_failed');
      expect(parsed.error?.message).toBe('wait socket failed');
    } finally {
      if (releaseLookupTimer) {
        clearTimeout(releaseLookupTimer);
      }
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('uses session RPC for active sessions so running agents receive the prompt through their runtime queue', async () => {
    const { handleSessionCommand } = await import('./index');
    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    const activeMetadataCiphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          path: '/tmp',
          tag: 'MyTag',
          host: 'host1',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 10,
          modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'claude-sonnet-4-0' },
        },
        dek!,
      ),
      'base64',
    );
    sessionActive = true;
    sessionActiveAt = 2;
    sessionMetadataCiphertext = activeMetadataCiphertext;
    sessionAgentStateCiphertext = null;
    sessionDataEncryptionKeyBase64 = encodeBase64Session(
      sealEncryptedDataKeyEnvelopeV1({
        dataKey: dek!,
        recipientPublicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
        randomBytes: (length) => new Uint8Array(length).fill(5),
      }),
      'base64',
    );

    const socket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((answer: any) => void) | undefined];
        if (event === SOCKET_RPC_EVENTS.CALL) {
          expect(String(data.method ?? '')).toBe(`${sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`);
          const decrypted = decryptWithDataKey(
            decodeBase64(String(data.params ?? ''), 'base64'),
            dek!,
          ) as any;
          expect(decrypted).toMatchObject({
            text: 'Hello active session',
            meta: expect.objectContaining({
              sentFrom: 'cli',
              source: 'ui',
              permissionMode: 'safe-yolo',
              model: 'claude-sonnet-4-0',
            }),
          });
          cb?.({ ok: true, result: encodeBase64Session(encryptWithDataKey({ ok: true }, dek!), 'base64') });
          return;
        }
        throw new Error(`Unexpected socket event: ${event}`);
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['send', sessionId, 'Hello active session', '--json'], {
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
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(receivedMessages).toHaveLength(0);
    } finally {
      output.restore();
    }
  });

  it('waits for the active-session prompt to materialize before returning from --wait', async () => {
    const { handleSessionCommand } = await import('./index');
    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    const idleAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: {} }, dek!),
      'base64',
    );

    sessionActive = true;
    sessionActiveAt = 2;
    sessionAgentStateCiphertext = idleAgentStateCiphertext;

    const rpcSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((answer: any) => void) | undefined];
        if (event === SOCKET_RPC_EVENTS.CALL) {
          expect(String(data.method ?? '')).toBe(`${sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`);
          const decrypted = decryptWithDataKey(
            decodeBase64(String(data.params ?? ''), 'base64'),
            dek!,
          ) as any;
          recordActiveSessionRpcLocalId(decrypted?.localId);
          cb?.({ ok: true, result: encodeBase64Session(encryptWithDataKey({ ok: true }, dek!), 'base64') });
          return;
        }
        throw new Error(`Unexpected socket event: ${event}`);
      },
    });
    const waitSocket = createApiSessionSocketStub({
      onConnect: (connectedSocket) => {
        setTimeout(() => {
          transcriptMessages = [
            ...transcriptMessages,
            {
              id: 'msg-active-wait-complete',
              seq: 8,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    agentId: 'claude',
                    data: { type: 'task_complete', id: 'task_send_wait_1' },
                  },
                },
              },
            },
          ];
          connectedSocket.trigger('update', {
            id: 'u_task_complete',
            seq: 8,
            createdAt: Date.now(),
            body: {
              t: 'new-message',
              sid: sessionId,
              message: {
                id: 'msg-active-wait-complete',
                seq: 8,
                localId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                content: {
                  t: 'plain',
                  v: {
                    role: 'agent',
                    content: {
                      type: 'acp',
                      agentId: 'claude',
                      data: { type: 'task_complete', id: 'task_send_wait_1' },
                    },
                  },
                },
              },
            },
          });
        }, 700);
      },
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, waitSocket]);

    const output = captureConsoleJsonOutput();
    let releaseLookupTimer: NodeJS.Timeout | null = null;
    try {
      onActiveSessionRpcLocalId = (localId) => {
        releaseLookupTimer = setTimeout(() => {
          visibleMessageByLocalId = {
            id: 'msg-active-wait-1',
            seq: 7,
            localId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            content: { t: 'encrypted', c: 'ciphertext' },
          };
          transcriptMessages = [
            {
              id: 'msg-active-wait-user',
              seq: 6,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'Wait for this prompt' },
                },
              },
            },
            {
              id: 'msg-active-wait-started',
              seq: 7,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    agentId: 'claude',
                    data: { type: 'task_started', id: 'task_send_wait_1' },
                  },
                },
              },
            },
          ];
        }, 40);
      };

      const sendPromise = handleSessionCommand(
        ['send', sessionId, 'Wait for this prompt', '--wait', '--timeout', '1', '--json'],
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
      let settled = false;
      void sendPromise.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      const parsedBeforeCompletion = output.logs.join('\n').trim();
      expect(parsedBeforeCompletion).toBe('');

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await sendPromise;

      const parsed = output.json();
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.waited).toBe(true);
      expect(transcriptLookupRequests).toBeGreaterThan(0);
    } finally {
      if (releaseLookupTimer) clearTimeout(releaseLookupTimer);
      output.restore();
    }
  });

  it('waits for active-session completion even when the refreshed agentState snapshot stays stale-busy after reconnect', async () => {
    const { handleSessionCommand } = await import('./index');
    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    const busyAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: { r1: { createdAt: 1 } } }, dek!),
      'base64',
    );

    sessionActive = true;
    sessionActiveAt = 2;
    sessionAgentStateCiphertext = busyAgentStateCiphertext;

    const rpcSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((answer: any) => void) | undefined];
        if (event === SOCKET_RPC_EVENTS.CALL) {
          expect(String(data.method ?? '')).toBe(`${sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`);
          const decrypted = decryptWithDataKey(
            decodeBase64(String(data.params ?? ''), 'base64'),
            dek!,
          ) as any;
          recordActiveSessionRpcLocalId(decrypted?.localId);
          cb?.({ ok: true, result: encodeBase64Session(encryptWithDataKey({ ok: true }, dek!), 'base64') });
          return;
        }
        throw new Error(`Unexpected socket event: ${event}`);
      },
    });
    const waitSocket = createApiSessionSocketStub({
      onConnect: (connectedSocket) => {
        setTimeout(() => {
          connectedSocket.trigger('update', {
            id: 'u_task_complete_stale_busy',
            seq: 8,
            createdAt: Date.now(),
            body: {
              t: 'new-message',
              sid: sessionId,
              message: {
                id: 'msg-active-wait-complete-stale-busy',
                seq: 8,
                localId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                content: {
                  t: 'plain',
                  v: {
                    role: 'agent',
                    content: {
                      type: 'acp',
                      agentId: 'opencode',
                      data: { type: 'task_complete', id: 'task_send_wait_stale_busy_1' },
                    },
                  },
                },
              },
            },
          });
        }, 700);
      },
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, waitSocket]);

    const output = captureConsoleJsonOutput();
    let releaseLookupTimer: NodeJS.Timeout | null = null;
    let transcriptCompletionTimer: NodeJS.Timeout | null = null;
    try {
      onActiveSessionRpcLocalId = (localId) => {
        releaseLookupTimer = setTimeout(() => {
          visibleMessageByLocalId = {
            id: 'msg-active-wait-stale-busy-user',
            seq: 7,
            localId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            content: { t: 'encrypted', c: 'ciphertext' },
          };
          transcriptMessages = [
            {
              id: 'msg-active-wait-stale-busy-user',
              seq: 6,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'Wait for stale busy reconnect' },
                },
              },
            },
            {
              id: 'msg-active-wait-stale-busy-started',
              seq: 7,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    agentId: 'opencode',
                    data: { type: 'task_started', id: 'task_send_wait_stale_busy_1' },
                  },
                },
              },
            },
          ];
        }, 20);
      };

      transcriptCompletionTimer = setTimeout(() => {
        transcriptMessages = [
          ...transcriptMessages,
          {
            id: 'msg-active-wait-stale-busy-complete',
            seq: 8,
            createdAt: Date.now(),
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: {
                  type: 'acp',
                  agentId: 'opencode',
                  data: { type: 'task_complete', id: 'task_send_wait_stale_busy_1' },
                },
              },
            },
          },
        ];
      }, 760);

      await handleSessionCommand(
        ['send', sessionId, 'Wait for stale busy reconnect', '--wait', '--timeout', '2', '--json'],
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

      const parsed = output.json();
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.waited).toBe(true);
    } finally {
      if (releaseLookupTimer) clearTimeout(releaseLookupTimer);
      if (transcriptCompletionTimer) clearTimeout(transcriptCompletionTimer);
      output.restore();
    }
  });

  it('treats task completion as completion when an active-session prompt materializes', async () => {
    const { handleSessionCommand } = await import('./index');
    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    const idleAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: {} }, dek!),
      'base64',
    );

    sessionActive = true;
    sessionActiveAt = 2;
    sessionAgentStateCiphertext = idleAgentStateCiphertext;

    const rpcSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((answer: any) => void) | undefined];
        if (event === SOCKET_RPC_EVENTS.CALL) {
          expect(String(data.method ?? '')).toBe(`${sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`);
          const decrypted = decryptWithDataKey(
            decodeBase64(String(data.params ?? ''), 'base64'),
            dek!,
          ) as any;
          recordActiveSessionRpcLocalId(decrypted?.localId);
          cb?.({ ok: true, result: encodeBase64Session(encryptWithDataKey({ ok: true }, dek!), 'base64') });
          return;
        }
        throw new Error(`Unexpected socket event: ${event}`);
      },
    });
    const waitSocket = createApiSessionSocketStub({
      onConnect: (connectedSocket) => {
        setTimeout(() => {
          transcriptMessages = [
            ...transcriptMessages,
            {
              id: 'msg-active-wait-task-complete',
              seq: 8,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    agentId: 'codex',
                    data: { type: 'task_complete', id: 'task_send_wait_1' },
                  },
                },
              },
            },
          ];
          connectedSocket.trigger('update', {
            id: 'u_task_complete',
            seq: 8,
            createdAt: Date.now(),
            body: {
              t: 'new-message',
              sid: sessionId,
              message: {
                id: 'msg-active-wait-task-complete',
                seq: 8,
                localId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                content: {
                  t: 'plain',
                  v: {
                    role: 'agent',
                    content: {
                      type: 'acp',
                      agentId: 'codex',
                      data: { type: 'task_complete', id: 'task_send_wait_1' },
                    },
                  },
                },
              },
            },
          });
        }, 700);
      },
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, waitSocket]);

    const output = captureConsoleJsonOutput();
    let releaseLookupTimer: NodeJS.Timeout | null = null;
    try {
      onActiveSessionRpcLocalId = (localId) => {
        releaseLookupTimer = setTimeout(() => {
          visibleMessageByLocalId = {
            id: 'msg-active-ready-user',
            seq: 7,
            localId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            content: { t: 'encrypted', c: 'ciphertext' },
          };
          transcriptMessages = [
            {
              id: 'msg-active-ready-transcript-user',
              seq: 6,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'Wait for task completion' },
                },
              },
            },
          ];
        }, 40);
      };

      const sendPromise = handleSessionCommand(
        ['send', sessionId, 'Wait for task completion', '--wait', '--timeout', '1', '--json'],
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

      let settled = false;
      void sendPromise.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await sendPromise;

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.waited).toBe(true);
      expect(transcriptLookupRequests).toBeGreaterThan(0);
    } finally {
      if (releaseLookupTimer) clearTimeout(releaseLookupTimer);
      output.restore();
    }
  });

  it('ignores older unresolved turns when waiting for the current send to reach task completion', async () => {
    const { handleSessionCommand } = await import('./index');
    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    const idleAgentStateCiphertext = encodeBase64Session(
      encryptWithDataKey({ controlledByUser: false, requests: {} }, dek!),
      'base64',
    );

    sessionActive = true;
    sessionActiveAt = 2;
    sessionAgentStateCiphertext = idleAgentStateCiphertext;

    const rpcSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [data, cb] = args as [any, ((answer: any) => void) | undefined];
        if (event === SOCKET_RPC_EVENTS.CALL) {
          expect(String(data.method ?? '')).toBe(`${sessionId}:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`);
          const decrypted = decryptWithDataKey(
            decodeBase64(String(data.params ?? ''), 'base64'),
            dek!,
          ) as any;
          recordActiveSessionRpcLocalId(decrypted?.localId);
          cb?.({ ok: true, result: encodeBase64Session(encryptWithDataKey({ ok: true }, dek!), 'base64') });
          return;
        }
        throw new Error(`Unexpected socket event: ${event}`);
      },
    });
    const waitSocket = createApiSessionSocketStub({
      onConnect: (connectedSocket) => {
        setTimeout(() => {
          transcriptMessages = [
            ...transcriptMessages,
            {
              id: 'msg-current-turn-task-complete',
              seq: 4,
              createdAt: Date.now(),
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: {
                    type: 'acp',
                    agentId: 'codex',
                    data: { type: 'task_complete', id: 'task_send_wait_current_turn' },
                  },
                },
              },
            },
          ];
          connectedSocket.trigger('update', {
            id: 'u_task_complete_current_turn',
            seq: 4,
            createdAt: Date.now(),
            body: {
              t: 'new-message',
              sid: sessionId,
              message: {
                id: 'msg-current-turn-task-complete',
                seq: 4,
                localId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                content: {
                  t: 'plain',
                  v: {
                    role: 'agent',
                    content: {
                      type: 'acp',
                      agentId: 'codex',
                      data: { type: 'task_complete', id: 'task_send_wait_current_turn' },
                    },
                  },
                },
              },
            },
          });
        }, 700);
      },
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, waitSocket]);

    const output = captureConsoleJsonOutput();
    let releaseLookupTimer: NodeJS.Timeout | null = null;
    try {
      onActiveSessionRpcLocalId = (localId) => {
        releaseLookupTimer = setTimeout(() => {
          visibleMessageByLocalId = {
            id: 'msg-current-turn-user',
            seq: 3,
            localId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            content: { t: 'encrypted', c: 'ciphertext' },
          };
          transcriptMessages = [
            {
              id: 'msg-old-user',
              seq: 1,
              createdAt: Date.now() - 2_000,
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'Older unresolved prompt' },
                },
              },
            },
            {
              id: 'msg-old-agent',
              seq: 2,
              createdAt: Date.now() - 1_500,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: { type: 'text', text: 'Older assistant reply without lifecycle markers' },
                },
              },
            },
            {
              id: 'msg-current-turn-user',
              seq: 3,
              localId,
              createdAt: Date.now() - 1_000,
              content: {
                t: 'plain',
                v: {
                  role: 'user',
                  content: { type: 'text', text: 'Wait only for the current send' },
                },
              },
            },
          ];
        }, 40);
      };

      await handleSessionCommand(
        ['send', sessionId, 'Wait only for the current send', '--wait', '--timeout', '1', '--json'],
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

      const parsed = output.json();
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.waited).toBe(true);
      expect(transcriptAfterSeqRequests.some((value) => typeof value === 'number' && value >= 0)).toBe(true);
    } finally {
      if (releaseLookupTimer) clearTimeout(releaseLookupTimer);
      output.restore();
    }
  });

  it('falls back to committed socket send when active-session RPC cannot connect', async () => {
    const { handleSessionCommand } = await import('./index');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    sessionActive = true;
    sessionActiveAt = 2;

    const rpcSocket = createApiSessionSocketStub();
    rpcSocket.connect = vi.fn(() => {
      rpcSocket.trigger('connect_error', new Error('connect_error'));
      return rpcSocket;
    });
    const committedSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [payload, ack] = args as [any, ((answer: any) => void) | undefined];
        if (event !== 'message') {
          throw new Error(`Unexpected socket event: ${event}`);
        }
        expect(payload).toEqual(expect.objectContaining({ messageRole: 'user' }));
        const content = payload?.message;
        if (content?.t === 'encrypted') {
          const decrypted = decryptWithDataKeyFn!(
            decodeBase64Fn!(String(content?.c ?? ''), 'base64'),
            dek!,
          );
          receivedMessages.push(decrypted);
        }
        ack?.({ ok: true, id: 'm1', seq: 2, localId: payload?.localId ?? null, didWrite: true });
      },
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, committedSocket]);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['send', sessionId, 'Fallback after connect error', '--json'], {
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
      expect(parsed.kind).toBe('session_send');
      expect(receivedMessages.at(-1)).toMatchObject({
        role: 'user',
        content: { type: 'text', text: 'Fallback after connect error' },
      });
    } finally {
      output.restore();
    }
  });

  it('falls back to committed socket send when active-session RPC reports session_not_found', async () => {
    const { handleSessionCommand } = await import('./index');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    sessionActive = true;
    sessionActiveAt = 2;

    const rpcSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [, ack] = args as [unknown, ((answer: unknown) => void) | undefined];
        if (event !== SOCKET_RPC_EVENTS.CALL) {
          throw new Error(`Unexpected socket event: ${event}`);
        }
        ack?.({ ok: false, error: 'stale active session rpc', errorCode: 'session_not_found' });
      },
    });
    const committedSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [payload, ack] = args as [any, ((answer: any) => void) | undefined];
        if (event !== 'message') {
          throw new Error(`Unexpected socket event: ${event}`);
        }
        const content = payload?.message;
        if (content?.t === 'encrypted') {
          const decrypted = decryptWithDataKeyFn!(
            decodeBase64Fn!(String(content?.c ?? ''), 'base64'),
            dek!,
          );
          receivedMessages.push(decrypted);
        }
        ack?.({ ok: true, id: 'm1', seq: 2, localId: payload?.localId ?? null, didWrite: true });
      },
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, committedSocket]);

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['send', sessionId, 'Fallback after session_not_found', '--json'], {
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
      expect(parsed.kind).toBe('session_send');
      expect(receivedMessages.at(-1)).toMatchObject({
        role: 'user',
        content: { type: 'text', text: 'Fallback after session_not_found' },
      });
    } finally {
      output.restore();
    }
  });

  it('does not retry via committed socket send after an active-session RPC timeout', async () => {
    const { handleSessionCommand } = await import('./index');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    sessionActive = true;
    sessionActiveAt = 2;

    const socket = createApiSessionSocketStub({
      emit: (event: string) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) {
          throw new Error(`Unexpected socket event: ${event}`);
        }
      },
    });
    bindApiSessionSocketMock(mockIo, socket);

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['send', sessionId, 'Do not duplicate on timeout', '--json'], {
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
      expect(parsed.kind).toBe('session_send');
      expect(parsed.error?.code).toBe('timeout');
      expect(parsed.error?.message).toContain('RPC call timeout');
      expect(mockIo).toHaveBeenCalledTimes(1);
      expect(receivedMessages).toHaveLength(0);
    } finally {
      output.restore();
    }
  }, 45_000);

  it('supports --permission-mode and --model overrides for a single send', async () => {
    sessionActive = true;
    sessionActiveAt = 3;
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
        if (event !== 'message') {
          throw new Error(`Unexpected socket event: ${event}`);
        }
        const content = payload?.message;
        if (content?.t === 'encrypted') {
          const decrypted = decryptWithDataKeyFn!(
            decodeBase64Fn!(String(content?.c ?? ''), 'base64'),
            dek!,
          );
          receivedMessages.push(decrypted);
        }
        ack?.({ ok: true, id: 'm1', seq: 2, localId: payload?.localId ?? null, didWrite: true });
      },
    });
    bindApiSessionSocketSequenceMock(mockIo, [rpcSocket, committedSocket]);

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        ['send', 'sess_integration_send_123', 'Hello from controller', '--permission-mode', 'bypassPermissions', '--model', 'default', '--json'],
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

      const parsed = output.json();
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');

      const last = receivedMessages[receivedMessages.length - 1];
      expect(last?.meta?.permissionMode).toBe('yolo');
      expect(last?.meta?.model).toBeUndefined();
    } finally {
      output.restore();
    }
  });
});
