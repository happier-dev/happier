import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

describe('happier resume command (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
  let server: Server | null = null;
  let serverUrl = '';
  let happyHomeDir = '';
  let requestCount = 0;
  let lastAuthHeader: string | null = null;

  beforeEach(async () => {
    requestCount = 0;
    lastAuthHeader = null;
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-resume-'));

    const sessionId = 'sess_integration_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64, encryptWithDataKey } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64(
      encryptWithDataKey(
        {
          path: '/tmp/happier-resume-integration',
          flavor: 'claude',
        },
        dek,
      ),
      'base64',
    );

    const dataEncryptionKeyBase64 = encodeBase64(envelope, 'base64');

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        requestCount += 1;
        lastAuthHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              metadata: metadataCiphertext,
              metadataVersion: 0,
              dataEncryptionKey: dataEncryptionKeyBase64,
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
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve resume integration test server address');
    }

    serverUrl = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_SERVER_URL = serverUrl;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
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
    if (originalAttachFile === undefined) delete process.env.HAPPIER_SESSION_ATTACH_FILE;
    else process.env.HAPPIER_SESSION_ATTACH_FILE = originalAttachFile;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('fetches encrypted session, decrypts metadata, and passes attach file to the agent handler', async () => {
    const { handleResumeCommand } = await import('./resume');
    const { readSessionAttachFromEnv } = await import('@/agent/runtime/sessionAttach');

    const token = 'token_test';
    const machineKeySeed = new Uint8Array(32).fill(8);

    let observedAgentId: string | null = null;
    let observedArgs: string[] | null = null;
    let observedAttach: { variant: string; key: Uint8Array } | null = null;
    let observedChdir: string | null = null;

    await handleResumeCommand(['sess_integration_123'], {
      readCredentialsFn: async () => ({
        token,
        encryption: {
          type: 'dataKey',
          publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
          machineKey: machineKeySeed,
        },
      }),
      resolveAgentHandlerFn: async (agentId) => {
        observedAgentId = agentId;
        return async (context) => {
          observedArgs = context.args;
          const attach = await readSessionAttachFromEnv();
          expect(attach).not.toBeNull();
          observedAttach = attach
            ? { variant: attach.encryptionVariant, key: attach.encryptionKey }
            : null;
        };
      },
      chdirFn: (nextDir) => {
        observedChdir = nextDir;
      },
    });

    expect(requestCount).toBe(1);
    expect(lastAuthHeader).toBe(`Bearer ${token}`);
    expect(observedChdir).toBe('/tmp/happier-resume-integration');
    expect(observedAgentId).toBe('claude');
    expect(observedArgs).toEqual(['claude', '--existing-session', 'sess_integration_123', '--started-by', 'terminal']);
    if (!observedAttach) {
      throw new Error('Expected attach payload to be present');
    }
    expect(observedAttach).toEqual({ variant: 'dataKey', key: new Uint8Array(32).fill(3) });
    expect(process.env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
  });
});
