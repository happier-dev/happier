import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));

describe('happier session run wait (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-run-wait-'));

    const sessionId = 'sess_integration_run_wait_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64Session(encryptWithDataKey({ path: '/tmp' }, dek), 'base64');
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
              agentState: null,
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

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS = '10';

    mockIo.mockReset();

    const { decodeBase64, decrypt, encodeBase64: encodeBase64Rpc, encrypt } = await import('@/api/encryption');
    let getCount = 0;
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
        if (event !== SOCKET_RPC_EVENTS.CALL) return;
        if (String(data.method ?? '') !== `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`) return;

        const decodedParams = decodeBase64(String(data.params ?? ''), 'base64');
        const decrypted = decrypt(dek, 'dataKey', decodedParams) as any;
        expect(decrypted).toMatchObject({ runId: 'run_1' });

        getCount += 1;
        const status = getCount >= 2 ? 'succeeded' : 'running';
        const run = {
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'call_1',
          intent: 'review',
          backendId: 'claude',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
          status,
          startedAtMs: 1,
          ...(status !== 'running' ? { finishedAtMs: 2 } : {}),
        };
        const resultPayload = { run };
        cb?.({ ok: true, result: encodeBase64Rpc(encrypt(dek, 'dataKey', resultPayload), 'base64') });
      });
      return { on, emit, connect, disconnect: vi.fn(), close: vi.fn() };
    });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    server = null;
    if (happyHomeDir) await rm(happyHomeDir, { recursive: true, force: true });

    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;

    delete process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('polls run get until terminal and returns a session_run_wait JSON envelope', async () => {
    const { handleSessionCommand } = await import('../index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')));

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(['run', 'wait', 'sess_integration_run_wait_123', 'run_1', '--timeout', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'dataKey', publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed), machineKey: machineKeySeed },
        }),
      });

      const parsed = JSON.parse(stdout.join('\\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_run_wait');
      expect(parsed.data?.sessionId).toBe('sess_integration_run_wait_123');
      expect(parsed.data?.runId).toBe('run_1');
      expect(parsed.data?.status).toBe('succeeded');
    } finally {
      logSpy.mockRestore();
    }
  });
});
