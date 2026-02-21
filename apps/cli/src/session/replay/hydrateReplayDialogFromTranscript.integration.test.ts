import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

describe('hydrateReplayDialogFromTranscript (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-replay-hydrate-'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (happyHomeDir) {
      await rm(happyHomeDir, { recursive: true, force: true });
    }

    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('hydrates plaintext sessions without session encryption materials', async () => {
    const sessionId = 'sess_plain_1';

    const sessionRow = {
      id: sessionId,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude', path: '/tmp' }),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            messages: [
              {
                seq: 1,
                createdAt: 1000,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
              },
            ],
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
    if (!address || typeof address === 'string') throw new Error('Failed to resolve replay hydrate server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateReplayDialogFromTranscript } = await import('./hydrateReplayDialogFromTranscript');

    const res = await hydrateReplayDialogFromTranscript({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      previousSessionId: sessionId,
      limit: 50,
    });

    expect(res).not.toBeNull();
    expect(res?.dialog?.[0]?.text).toBe('hello');
  });

  it('hydrates encrypted sessions using the published session dataEncryptionKey', async () => {
    const sessionId = 'sess_enc_1';

    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64, encryptWithDataKey } = await import('@/api/encryption');
    const dataEncryptionKeyBase64 = encodeBase64(envelope, 'base64');
    const msgCiphertext = encodeBase64(
      encryptWithDataKey({ role: 'user', content: { type: 'text', text: 'hello' } }, dek),
      'base64',
    );

    const sessionRow = {
      id: sessionId,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      metadata: 'b64',
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: dataEncryptionKeyBase64,
      share: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            messages: [
              {
                seq: 1,
                createdAt: 1000,
                content: { t: 'encrypted', c: msgCiphertext },
              },
            ],
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
    if (!address || typeof address === 'string') throw new Error('Failed to resolve replay hydrate server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateReplayDialogFromTranscript } = await import('./hydrateReplayDialogFromTranscript');

    const res = await hydrateReplayDialogFromTranscript({
      credentials: {
        token: 't',
        encryption: {
          type: 'dataKey',
          publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
          machineKey: machineKeySeed,
        },
      },
      previousSessionId: sessionId,
      limit: 50,
    });

    expect(res).not.toBeNull();
    expect(res?.dialog?.[0]?.text).toBe('hello');
  });
});

