import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { respondTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';

const SESSION_ID = 'sess_empty_source';
const CREDENTIALS = {
  token: 't',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

type SourceMode = 'empty' | 'failed' | 'unreadable' | 'whitespace' | 'dialog';

function replayRows(mode: SourceMode): readonly Record<string, unknown>[] {
  const contentFor = (text: string) => ({
    t: 'plain',
    v: { role: 'user', content: { type: 'text', text } },
  });
  switch (mode) {
    case 'empty':
    case 'failed':
      return [];
    case 'unreadable':
      return [{ seq: 7, createdAt: 7, content: { t: 'plain', v: null } }];
    case 'whitespace':
      return [{ seq: 7, createdAt: 7, content: contentFor('   ') }];
    case 'dialog':
      return [{ seq: 7, createdAt: 7, content: contentFor('hello there') }];
  }
}

describe('resolveReplaySeedDraft — empty source vs failed retrieval', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let sourceMode: SourceMode = 'empty';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    sourceMode = 'empty';
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
    happyHomeDir = await createTempDir('happier-cli-replay-empty-source-');
    const session = {
      id: SESSION_ID,
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude', path: '/workspace' }),
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
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${SESSION_ID}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        if (sourceMode === 'failed') {
          res.statusCode = 503;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: replayRows(sourceMode) }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve server address');
    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
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
    if (happyHomeDir) await removeTempDir(happyHomeDir);
    envScope.restore();
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  async function resolve() {
    const { resolveReplaySeedDraft } = await import('./resolveReplaySeedDraft');
    return await resolveReplaySeedDraft({
      credentials: CREDENTIALS,
      cwd: '/workspace',
      source: { kind: 'fork_chain', previousSessionId: SESSION_ID, upToSeqInclusive: 7 },
      strategy: 'recent_messages',
      recentMessagesCount: 8,
      maxSeedChars: 4_000,
      candidateLimit: 8,
    });
  }

  it('reports a source with no dialog distinctly from a failed retrieval', async () => {
    expect((await resolve()).status).toBe('no_source_dialog');
    sourceMode = 'failed';
    expect((await resolve()).status).toBe('unavailable');
  });

  it('reports an empty dialog with an unreadable transcript row as unavailable', async () => {
    sourceMode = 'unreadable';
    expect((await resolve()).status).toBe('unavailable');
  });

  it('reports rows that yield no usable prompt text as an empty source', async () => {
    sourceMode = 'whitespace';
    expect((await resolve()).status).toBe('no_source_dialog');
  });

  it('composes the real activation brief as no source dialog for an empty Session', async () => {
    const { buildSessionAgentTransitionActivationBrief } = await import(
      '../agentTransition/buildSessionAgentTransitionActivationBrief',
    );
    await expect(buildSessionAgentTransitionActivationBrief({
      credentials: CREDENTIALS,
      sessionId: SESSION_ID,
      sourceAgentId: 'claude',
      targetAgentId: 'codex',
      workspacePath: '/workspace',
      departingAgentCurrentView: null,
      transcriptHeadSeqInclusive: 7,
    })).resolves.toEqual({ status: 'no_source_dialog' });
  });

  it('still carries a seed when the source has dialog', async () => {
    sourceMode = 'dialog';
    const resolved = await resolve();
    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).toContain('hello there');
    expect(resolved.sourceCutoffSeqInclusive).toBe(7);
  });
});
