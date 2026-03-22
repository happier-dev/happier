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
  let sessionMetadataCiphertext = '';
  let sessionAgentStateCiphertext: string | null = null;
  let sessionDataEncryptionKeyBase64 = '';
  let visibleMessageByLocalId: { id: string; localId: string; seq: number; createdAt: number; updatedAt: number; content: any } | null = null;
  let transcriptLookupRequests = 0;
  let transcriptMessages: Array<Record<string, unknown>> = [];
  let lastActiveSessionRpcLocalId: string | null = null;

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
    sessionMetadataCiphertext = metadataCiphertext;
    sessionAgentStateCiphertext = busyAgentStateCiphertext;
    sessionDataEncryptionKeyBase64 = dataEncryptionKeyBase64;
    visibleMessageByLocalId = null;
    transcriptLookupRequests = 0;
    transcriptMessages = [];
    lastActiveSessionRpcLocalId = null;

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
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: transcriptMessages }));
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
          if (content?.t === 'encrypted') {
            const decrypted = decryptWithDataKeyFn!(
              decodeBase64Fn!(String(content?.c ?? ''), 'base64'),
              dek!,
            );
            receivedMessages.push(decrypted);
          } else if (content?.t === 'plain') {
            receivedMessages.push(content.v);
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

  it('commits an encrypted user message and returns a session_send JSON envelope', async () => {
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

      const parsed = output.json();
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.sessionId).toBe('sess_integration_send_123');
      expect(typeof parsed.data?.localId).toBe('string');
      expect(parsed.data?.waited).toBe(false);

      const last = receivedMessages[receivedMessages.length - 1];
      expect(last).toMatchObject({
        role: 'user',
        content: { type: 'text', text: 'Hello from controller' },
      });
      expect(last?.meta?.sentFrom).toBe('cli');
      expect(last?.meta?.permissionMode).toBe('safe-yolo');
      expect(last?.meta?.model).toBe('claude-sonnet-4-0');
    } finally {
      output.restore();
    }
  });

  it('supports --wait and returns waited=true in JSON mode', async () => {
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

      const parsed = output.json();
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.sessionId).toBe('sess_integration_send_123');
      expect(parsed.data?.waited).toBe(true);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('surfaces non-timeout wait failures without rewriting them to timeout', async () => {
    const { handleSessionCommand } = await import('./index');

    const machineKeySeed = new Uint8Array(32).fill(8);
    const sendSocket = createApiSessionSocketStub({
      emit: (event: string, args: unknown[]) => {
        const [payload, ack] = args as [any, ((answer: any) => void) | undefined];
        if (event !== 'message') {
          throw new Error(`Unexpected socket event: ${event}`);
        }
        ack?.({ ok: true, id: 'm1', seq: 2, localId: payload?.localId ?? null, didWrite: true });
      },
    });
    const waitSocket = createApiSessionSocketStub();
    waitSocket.connect = vi.fn(() => {
      waitSocket.trigger('connect_error', new Error('wait socket failed'));
      return waitSocket;
    });
    bindApiSessionSocketSequenceMock(mockIo, [sendSocket, waitSocket]);

    const output = captureConsoleJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
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

      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.error?.code).toBe('wait_failed');
      expect(parsed.error?.message).toBe('wait socket failed');
    } finally {
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
              source: 'cli',
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
      expect(parsed.ok).toBe(true);
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
          lastActiveSessionRpcLocalId = typeof decrypted?.localId === 'string' ? decrypted.localId : null;
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
                      provider: 'claude',
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
      releaseLookupTimer = setTimeout(() => {
        if (!lastActiveSessionRpcLocalId) {
          return;
        }
        visibleMessageByLocalId = {
          id: 'msg-active-wait-1',
          seq: 7,
          localId: lastActiveSessionRpcLocalId,
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
                  provider: 'claude',
                  data: { type: 'task_started', id: 'task_send_wait_1' },
                },
              },
            },
          },
        ];
      }, 40);

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
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.waited).toBe(true);
      expect(transcriptLookupRequests).toBeGreaterThan(0);
    } finally {
      if (releaseLookupTimer) clearTimeout(releaseLookupTimer);
      output.restore();
    }
  });

  it('treats a ready event as completion when an active-session prompt materializes without ACP task_complete', async () => {
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
          lastActiveSessionRpcLocalId = typeof decrypted?.localId === 'string' ? decrypted.localId : null;
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
            id: 'u_ready',
            seq: 8,
            createdAt: Date.now(),
            body: {
              t: 'new-message',
              sid: sessionId,
              message: {
                id: 'msg-active-wait-ready',
                seq: 8,
                localId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                content: {
                  t: 'plain',
                  v: {
                    role: 'agent',
                    content: {
                      id: 'ready_evt_send_wait_1',
                      type: 'event',
                      data: { type: 'ready' },
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
      releaseLookupTimer = setTimeout(() => {
        if (!lastActiveSessionRpcLocalId) {
          return;
        }
        visibleMessageByLocalId = {
          id: 'msg-active-ready-user',
          seq: 7,
          localId: lastActiveSessionRpcLocalId,
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
                content: { type: 'text', text: 'Wait for ready event' },
              },
            },
          },
        ];
      }, 40);

      const sendPromise = handleSessionCommand(
        ['send', sessionId, 'Wait for ready event', '--wait', '--timeout', '1', '--json'],
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
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

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
