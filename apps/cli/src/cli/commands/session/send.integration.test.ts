import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session send (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
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
  let lastActiveSessionRpcLocalId: string | null = null;

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-send-'));
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

    mockIo.mockReset();
    mockIo.mockImplementation(() => {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const on = vi.fn((event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      });
      const off = vi.fn((event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        handlers.set(event, list.filter((v) => v !== cb));
      });
      const connect = vi.fn(() => {
        setTimeout(() => {
          const list = handlers.get('connect') ?? [];
          for (const cb of list) cb();
        }, 0);
        setTimeout(() => {
          const list = handlers.get('update') ?? [];
          for (const cb of list) {
            cb({
              id: 'u1',
              seq: 2,
              createdAt: Date.now(),
              body: {
                t: 'update-session',
                id: sessionId,
                agentState: { value: idleAgentStateCiphertext, version: 1 },
              },
            });
          }
        }, 10);
      });
      const emit = vi.fn((event: string, payload: any, ack?: (answer: any) => void) => {
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
      });
      return {
        on,
        off,
        connect,
        emit,
        disconnect: vi.fn(),
        close: vi.fn(),
      };
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    }
    server = null;
    if (happyHomeDir) await rm(happyHomeDir, { recursive: true, force: true });

    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('commits an encrypted user message and returns a session_send JSON envelope', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

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

      const parsed = JSON.parse(stdout.join('\n').trim());
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
      logSpy.mockRestore();
    }
  });

  it('supports --wait and returns waited=true in JSON mode', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

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

      const parsed = JSON.parse(stdout.join('\n').trim());
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.sessionId).toBe('sess_integration_send_123');
      expect(parsed.data?.waited).toBe(true);
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });

  it('surfaces non-timeout wait failures without rewriting them to timeout', async () => {
    const { handleSessionCommand } = await import('./index');

    const machineKeySeed = new Uint8Array(32).fill(8);
    mockIo.mockReset();
    mockIo
      .mockImplementationOnce(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect') ?? [];
            for (const fn of list) fn();
          }),
          emit: vi.fn((event: string, payload: any, ack?: (answer: any) => void) => {
            if (event !== 'message') {
              throw new Error(`Unexpected socket event: ${event}`);
            }
            ack?.({ ok: true, id: 'm1', seq: 2, localId: payload?.localId ?? null, didWrite: true });
          }),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      })
      .mockImplementationOnce(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect_error') ?? [];
            for (const fn of list) fn(new Error('wait socket failed'));
          }),
          emit: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      });

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
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

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.error?.code).toBe('wait_failed');
      expect(parsed.error?.message).toBe('wait socket failed');
    } finally {
      logSpy.mockRestore();
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

    mockIo.mockReset();
    mockIo.mockImplementation(() => {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const on = vi.fn((event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      });
      const connect = vi.fn(() => {
        const list = handlers.get('connect') ?? [];
        for (const fn of list) fn();
      });
      const emit = vi.fn((event: string, data: any, cb?: (...args: any[]) => void) => {
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
      });
      return {
        on,
        off: vi.fn(),
        connect,
        emit,
        disconnect: vi.fn(),
        close: vi.fn(),
      };
    });

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

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

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(receivedMessages).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
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

    mockIo.mockReset();
    mockIo
      .mockImplementationOnce(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect') ?? [];
            for (const fn of list) fn();
          }),
          emit: vi.fn((event: string, data: any, cb?: (...args: any[]) => void) => {
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
          }),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      })
      .mockImplementationOnce(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect') ?? [];
            for (const fn of list) fn();
          }),
          emit: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      });

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
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

      const parsedBeforeCompletion = stdout.join('\n').trim();
      expect(parsedBeforeCompletion).toBe('');

      await new Promise((resolve) => setTimeout(resolve, 80));
      await sendPromise;

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.waited).toBe(true);
      expect(transcriptLookupRequests).toBeGreaterThan(0);
    } finally {
      if (releaseLookupTimer) clearTimeout(releaseLookupTimer);
      logSpy.mockRestore();
    }
  });

  it('falls back to committed socket send when active-session RPC cannot connect', async () => {
    const { handleSessionCommand } = await import('./index');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    sessionActive = true;
    sessionActiveAt = 2;

    mockIo.mockReset();
    mockIo
      .mockImplementationOnce(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect_error') ?? [];
            for (const fn of list) fn(new Error('connect_error'));
          }),
          emit: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      })
      .mockImplementationOnce(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect') ?? [];
            for (const fn of list) fn();
          }),
          emit: vi.fn((event: string, payload: any, ack?: (answer: any) => void) => {
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
          }),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      });

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

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

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(receivedMessages.at(-1)).toMatchObject({
        role: 'user',
        content: { type: 'text', text: 'Fallback after connect error' },
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not retry via committed socket send after an active-session RPC timeout', async () => {
    const { handleSessionCommand } = await import('./index');

    const sessionId = 'sess_integration_send_123';
    const machineKeySeed = new Uint8Array(32).fill(8);
    sessionActive = true;
    sessionActiveAt = 2;

    mockIo.mockReset();
    mockIo
      .mockImplementationOnce(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect') ?? [];
            for (const fn of list) fn();
          }),
          emit: vi.fn((event: string) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) {
              throw new Error(`Unexpected socket event: ${event}`);
            }
          }),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      })
      .mockImplementation(() => {
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        return {
          on: vi.fn((event: string, cb: (...args: any[]) => void) => {
            const list = handlers.get(event) ?? [];
            list.push(cb);
            handlers.set(event, list);
          }),
          off: vi.fn(),
          connect: vi.fn(() => {
            const list = handlers.get('connect') ?? [];
            for (const fn of list) fn();
          }),
          emit: vi.fn((event: string, payload: any, ack?: (answer: any) => void) => {
            if (event !== 'message') {
              throw new Error(`Unexpected socket event: ${event}`);
            }
            ack?.({ ok: true, id: 'm1', seq: 2, localId: payload?.localId ?? null, didWrite: true });
          }),
          disconnect: vi.fn(),
          close: vi.fn(),
        };
      });

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));
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

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.error?.code).toBe('timeout');
      expect(parsed.error?.message).toContain('RPC call timeout');
      expect(mockIo).toHaveBeenCalledTimes(1);
      expect(receivedMessages).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  }, 45_000);

  it('supports --permission-mode and --model overrides for a single send', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

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

      const parsed = JSON.parse(stdout.join('\n').trim());
      if (parsed.ok !== true) {
        throw new Error(`Unexpected session_send envelope: ${JSON.stringify(parsed)}`);
      }
      expect(parsed.kind).toBe('session_send');

      const last = receivedMessages[receivedMessages.length - 1];
      expect(last?.meta?.permissionMode).toBe('yolo');
      expect(last?.meta?.model).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});
