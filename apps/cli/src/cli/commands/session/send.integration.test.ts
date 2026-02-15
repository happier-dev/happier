import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

describe('happier session send (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-send-'));

    const sessionId = 'sess_integration_send_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey, decodeBase64, decryptWithDataKey } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64Session(
      encryptWithDataKey({ path: '/tmp', tag: 'MyTag', host: 'host1' }, dek),
      'base64',
    );
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');

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

      if (req.method === 'POST' && url.pathname === `/v2/sessions/${sessionId}/messages`) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ciphertext = String(body.ciphertext ?? '');

        const decrypted = decryptWithDataKey(decodeBase64(ciphertext, 'base64'), dek);
        expect(decrypted).toMatchObject({
          role: 'user',
          content: { type: 'text', text: 'Hello from controller' },
        });
        expect((decrypted as any)?.meta?.sentFrom).toBe('cli');

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ didWrite: true, message: { id: 'm1', seq: 2, localId: body.localId ?? null, createdAt: 3 } }));
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
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_send');
      expect(parsed.data?.sessionId).toBe('sess_integration_send_123');
      expect(typeof parsed.data?.localId).toBe('string');
      expect(parsed.data?.waited).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });
});

