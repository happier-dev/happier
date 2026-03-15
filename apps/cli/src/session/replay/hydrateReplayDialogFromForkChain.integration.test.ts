import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('hydrateReplayDialogFromForkChain (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-replay-hydrate-forkchain-'));
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

  it('discovers session synopsis even when it is outside the first replay page', async () => {
    const sessionId = 'sess_plain_chain_1';

    const sessionRow = {
      id: sessionId,
      seq: 400,
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

    const rows: Array<{ seq: number; createdAt: number; content: any }> = [];
    for (let i = 1; i <= 400; i += 1) {
      rows.push({
        seq: i,
        createdAt: 1000 + i,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `u${i}` } } },
      });
    }

    // Place synopsis far enough back that the newest 200 messages won't include it.
    rows.push({
      seq: 50,
      createdAt: 5000,
      content: {
        t: 'plain',
        v: {
          role: 'agent',
          content: { type: 'text', text: '[memory]' },
          meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 49, updatedAtMs: 9999, synopsis: 'SYNOPSIS_OK' } } },
        },
      },
    });

    const sortedRows = rows
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ seq: r.seq, createdAt: r.createdAt, content: r.content }));

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        const beforeSeqRaw = url.searchParams.get('beforeSeq');
        const limitRaw = url.searchParams.get('limit');
        const beforeSeq = beforeSeqRaw ? Number.parseInt(beforeSeqRaw, 10) : null;
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 150;

        const eligible = sortedRows.filter((r) => (beforeSeq == null ? true : r.seq < beforeSeq));
        const picked = eligible.slice().sort((a, b) => b.seq - a.seq).slice(0, limit);

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: picked }));
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

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateReplayDialogFromForkChain } = await import('./hydrateReplayDialogFromForkChain');

    const result = await hydrateReplayDialogFromForkChain({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      startingSessionId: sessionId,
      limit: 200,
      wantSynopsisText: true,
    });

    expect(result).not.toBeNull();
    expect(result?.synopsisText).toBe('SYNOPSIS_OK');
  });

  it('does not scan older pages for synopsis when wantSynopsisText is false', async () => {
    const sessionId = 'sess_plain_chain_2';

    const sessionRow = {
      id: sessionId,
      seq: 400,
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

    const rows: Array<{ seq: number; createdAt: number; content: any }> = [];
    for (let i = 1; i <= 400; i += 1) {
      rows.push({
        seq: i,
        createdAt: 1000 + i,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `u${i}` } } },
      });
    }

    // Place synopsis far enough back that the newest 200 messages won't include it.
    rows.push({
      seq: 50,
      createdAt: 5000,
      content: {
        t: 'plain',
        v: {
          role: 'agent',
          content: { type: 'text', text: '[memory]' },
          meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 49, updatedAtMs: 9999, synopsis: 'SYNOPSIS_OK' } } },
        },
      },
    });

    const sortedRows = rows
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ seq: r.seq, createdAt: r.createdAt, content: r.content }));

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        const beforeSeqRaw = url.searchParams.get('beforeSeq');
        const limitRaw = url.searchParams.get('limit');
        const beforeSeq = beforeSeqRaw ? Number.parseInt(beforeSeqRaw, 10) : null;
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 150;

        const eligible = sortedRows.filter((r) => (beforeSeq == null ? true : r.seq < beforeSeq));
        const picked = eligible.slice().sort((a, b) => b.seq - a.seq).slice(0, limit);

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: picked }));
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

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateReplayDialogFromForkChain } = await import('./hydrateReplayDialogFromForkChain');

    const result = await hydrateReplayDialogFromForkChain({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      startingSessionId: sessionId,
      limit: 200,
      wantSynopsisText: false,
    });

    expect(result).not.toBeNull();
    expect(result?.synopsisText).toBeNull();
  });

  it('prefers memorySynopsisPointerV1 when present (no pagination needed)', async () => {
    const sessionId = 'sess_plain_chain_3';
    const synopsisLocalId = 'memory:synopsis:v1:49';

    const sessionRow = {
      id: sessionId,
      seq: 400,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'claude',
        path: '/tmp',
        memorySynopsisPointerV1: { v: 1, localId: synopsisLocalId, seqTo: 49, updatedAtMs: 9999 },
      }),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };

    const rows: Array<{ seq: number; createdAt: number; content: any }> = [];
    for (let i = 1; i <= 400; i += 1) {
      rows.push({
        seq: i,
        createdAt: 1000 + i,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `u${i}` } } },
      });
    }

    const sortedRows = rows
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ seq: r.seq, createdAt: r.createdAt, content: r.content }));

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}/messages/by-local-id/${encodeURIComponent(synopsisLocalId)}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          message: {
            id: 'm_syn',
            seq: 50,
            localId: synopsisLocalId,
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'text', text: '[memory]' },
                meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 49, updatedAtMs: 9999, synopsis: 'SYNOPSIS_OK' } } },
              },
            },
            createdAt: 5000,
            updatedAt: 5001,
          },
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        const beforeSeqRaw = url.searchParams.get('beforeSeq');
        const limitRaw = url.searchParams.get('limit');
        const beforeSeq = beforeSeqRaw ? Number.parseInt(beforeSeqRaw, 10) : null;
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 150;

        // No synopsis artifact is present in any paged transcript window, forcing pointer usage.
        const eligible = sortedRows.filter((r) => (beforeSeq == null ? true : r.seq < beforeSeq));
        const picked = eligible.slice().sort((a, b) => b.seq - a.seq).slice(0, limit);

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: picked }));
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

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateReplayDialogFromForkChain } = await import('./hydrateReplayDialogFromForkChain');

    const result = await hydrateReplayDialogFromForkChain({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      startingSessionId: sessionId,
      limit: 200,
      wantSynopsisText: true,
    });

    expect(result).not.toBeNull();
    expect(result?.synopsisText).toBe('SYNOPSIS_OK');
  });
});
