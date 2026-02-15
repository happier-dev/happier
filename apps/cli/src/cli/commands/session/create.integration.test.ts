import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

describe('happier session create (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-create-'));

    const sessionId = 'sess_integration_create_123';

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }));
        return;
      }

      if (req.method === 'POST' && url.pathname === `/v1/sessions`) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

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
              metadata: body.metadata,
              metadataVersion: 0,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: body.dataEncryptionKey ?? null,
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
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve session control integration test server address');
    }

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
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

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('returns a session_create JSON envelope and marks created=true when tag does not exist', async () => {
    const { handleSessionCommand } = await import('./index');

    const machineKeySeed = new Uint8Array(32).fill(8);

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

    try {
      await handleSessionCommand(['create', '--tag', 'MyTag', '--json'], {
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
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_create');
      expect(parsed.data?.created).toBe(true);
      expect(parsed.data?.session?.id).toBe('sess_integration_create_123');
      expect(parsed.data?.session?.tag).toBe('MyTag');
      expect(parsed.data?.session?.encryption?.type).toBe('dataKey');
    } finally {
      logSpy.mockRestore();
    }
  });
});
