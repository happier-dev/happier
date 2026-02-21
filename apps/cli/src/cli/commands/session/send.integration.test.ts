import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

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
              metadata: metadataCiphertext,
              metadataVersion: 0,
              agentState: busyAgentStateCiphertext,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: dataEncryptionKeyBase64,
              encryptionMode: 'e2ee',
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
