import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const credentials: Credentials = {
  token: 'token-1',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

function createPlainSession(sessionId: string, seq = 1) {
  return {
    id: sessionId,
    seq,
    createdAt: 1,
    updatedAt: 2,
    active: false,
    activeAt: 0,
    archivedAt: null,
    encryptionMode: 'plain',
    metadata: JSON.stringify({ flavor: 'claude', path: '/tmp/project' }),
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    pendingCount: 0,
    pendingVersion: 0,
    dataEncryptionKey: null,
    share: null,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('resolveReplaySeedDraft auth propagation', () => {
  let server: Server | null = null;
  let homeDir = '';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
    homeDir = await createTempDir('happier-cli-replay-seed-auth-');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (homeDir) {
      await removeTempDir(homeDir);
    }
    envScope.restore();
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('propagates fork-chain session fetch auth failures', async () => {
    const sessionId = 'sess-auth-fetch';
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({}));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const serverUrl = await listen(server);
    envScope.patch({ HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000', HAPPIER_HOME_DIR: homeDir });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');

    await expect(
      resolveReplaySeedDraft({
        credentials,
        cwd: '/tmp/project',
        source: { kind: 'fork_chain', previousSessionId: sessionId },
        strategy: 'recent_messages',
        recentMessagesCount: 1,
        maxSeedChars: 2000,
        candidateLimit: 1,
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('propagates fork-chain transcript fetch auth failures', async () => {
    const sessionId = 'sess-auth-transcript';
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: createPlainSession(sessionId, 2) }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({}));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const serverUrl = await listen(server);
    envScope.patch({ HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000', HAPPIER_HOME_DIR: homeDir });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');

    await expect(
      resolveReplaySeedDraft({
        credentials,
        cwd: '/tmp/project',
        source: { kind: 'fork_chain', previousSessionId: sessionId },
        strategy: 'recent_messages',
        recentMessagesCount: 1,
        maxSeedChars: 2000,
        candidateLimit: 1,
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 403 },
      code: 'not_authenticated',
    });
  });

  it('propagates voice replay transcript auth failures', async () => {
    const sessionId = 'sess-voice-auth-transcript';
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: createPlainSession(sessionId, 2) }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({}));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const serverUrl = await listen(server);
    envScope.patch({ HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000', HAPPIER_HOME_DIR: homeDir });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');

    await expect(
      resolveReplaySeedDraft({
        credentials,
        cwd: '/tmp/project',
        source: { kind: 'voice_session.v1', previousSessionId: sessionId, transcriptEpoch: 0 },
        strategy: 'recent_messages',
        recentMessagesCount: 1,
        maxSeedChars: 2000,
        candidateLimit: 1,
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('keeps missing replay data as a null seed result', async () => {
    const sessionId = 'sess-missing';
    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Session not found' }));
    });

    const serverUrl = await listen(server);
    envScope.patch({ HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000', HAPPIER_HOME_DIR: homeDir });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');

    await expect(
      resolveReplaySeedDraft({
        credentials,
        cwd: '/tmp/project',
        source: { kind: 'fork_chain', previousSessionId: sessionId },
        strategy: 'recent_messages',
        recentMessagesCount: 1,
        maxSeedChars: 2000,
        candidateLimit: 1,
      }),
    ).resolves.toBeNull();
  });

  it('keeps non-auth transcript failures as a null seed result', async () => {
    const sessionId = 'sess-non-auth-transcript';
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: createPlainSession(sessionId, 2) }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'temporary failure' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const serverUrl = await listen(server);
    envScope.patch({ HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000', HAPPIER_HOME_DIR: homeDir });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');

    await expect(
      resolveReplaySeedDraft({
        credentials,
        cwd: '/tmp/project',
        source: { kind: 'fork_chain', previousSessionId: sessionId },
        strategy: 'recent_messages',
        recentMessagesCount: 1,
        maxSeedChars: 2000,
        candidateLimit: 1,
      }),
    ).resolves.toBeNull();
  });
});
