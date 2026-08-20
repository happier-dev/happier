import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { respondTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

describe('hydrateReplayDialogFromForkChain (integration)', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
    happyHomeDir = await createTempDir('happier-cli-replay-hydrate-forkchain-');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;

    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
    }
    envScope.restore();

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  /**
   * Every hydrated row says which Session's seq space its `seq` is numbered in.
   *
   * This walk is the one place two Sessions' seq spaces meet, and after the
   * createdAt sort the parent's row and the child's are indistinguishable by
   * number alone — here both are `seq: 1`. The replay seed's range claim is a
   * span in ONE space and its paging cursor is executed against ONE Session, so
   * without this fact the seed can hand the child a cursor taken from the
   * parent's numbering and the target skips every row above it, forever.
   */
  it('tags every hydrated row with the Session its seq is numbered in', async () => {
    const childSessionId = 'sess_chain_child';
    const parentSessionId = 'sess_chain_parent';

    const makeSession = (id: string, createdAt: number, metadata: Record<string, unknown>) => ({
      id,
      seq: 1,
      createdAt,
      updatedAt: createdAt + 1,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    });

    const sessions = new Map([
      [childSessionId, makeSession(childSessionId, 200, {
        flavor: 'claude',
        path: '/tmp',
        forkV1: { v: 1, parentSessionId, parentCutoffSeqInclusive: 1 },
      })],
      [parentSessionId, makeSession(parentSessionId, 100, { flavor: 'claude', path: '/tmp' })],
    ]);
    const messages = new Map<string, Array<Record<string, unknown>>>([
      [childSessionId, [{
        seq: 1,
        createdAt: 200,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'child turn' } } },
      }]],
      [parentSessionId, [{
        seq: 1,
        createdAt: 100,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'parent turn' } } },
      }]],
    ]);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const sessionMatch = /^\/v2\/sessions\/([^/]+)$/u.exec(url.pathname);
      if (req.method === 'GET' && sessionMatch) {
        const session = sessions.get(sessionMatch[1]!);
        res.statusCode = session ? 200 : 404;
        res.setHeader('content-type', 'application/json');
        res.end(session ? JSON.stringify({ session }) : undefined);
        return;
      }
      const messagesMatch = /^\/v1\/sessions\/([^/]+)\/messages$/u.exec(url.pathname);
      if (req.method === 'GET' && messagesMatch) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: messages.get(messagesMatch[1]!) ?? [] }));
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

    const { hydrateReplayDialogFromForkChain } = await import('./hydrateReplayDialogFromForkChain');
    const result = await hydrateReplayDialogFromForkChain({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      startingSessionId: childSessionId,
      limit: 10,
      wantSynopsisText: false,
    });

    expect(result?.dialog.map((item) => ({ text: item.text, seq: item.seq, sessionId: item.sessionId }))).toEqual([
      { text: 'parent turn', seq: 1, sessionId: parentSessionId },
      { text: 'child turn', seq: 1, sessionId: childSessionId },
    ]);
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
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
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

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
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
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
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

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
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
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
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

  it('prefers the latest synopsis system record over stale legacy transcript artifacts', async () => {
    const sessionId = 'sess_plain_chain_4';

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

    const rows = Array.from({ length: 400 }, (_, index) => {
      const seq = index + 1;
      return {
        seq,
        createdAt: 1000 + seq,
        content: seq === 350
          ? {
              t: 'plain',
              v: {
                role: 'agent',
                content: { type: 'text', text: '[memory]' },
                meta: {
                  happier: {
                    kind: 'session_synopsis.v1',
                    payload: { v: 1, seqTo: 349, updatedAtMs: 9998, synopsis: 'STALE_TRANSCRIPT_SYNOPSIS' },
                  },
                },
              },
            }
          : { t: 'plain', v: { role: 'user', content: { type: 'text', text: `u${seq}` } } },
      };
    });

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}/system-records/latest`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          record: {
            id: 'rec_synopsis',
            sessionId,
            namespace: 'memory',
            kind: 'synopsis.v1',
            localId: 'memory:synopsis:v1:49',
            content: { t: 'plain', v: { v: 1, seqTo: 49, updatedAtMs: 9999, synopsis: 'SYSTEM_RECORD_SYNOPSIS_OK' } },
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          },
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        const beforeSeqRaw = url.searchParams.get('beforeSeq');
        const limitRaw = url.searchParams.get('limit');
        const beforeSeq = beforeSeqRaw ? Number.parseInt(beforeSeqRaw, 10) : null;
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 150;
        const eligible = rows.filter((r) => (beforeSeq == null ? true : r.seq < beforeSeq));
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

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
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
    expect(result?.synopsisText).toBe('SYSTEM_RECORD_SYNOPSIS_OK');
  });

  /**
   * "The source carries no dialog" and "the bounded retrieval failed" are
   * different facts, and this hydrator — not its caller — is where the
   * distinction has to survive, because this is the only owner that can see
   * whether a segment's transcript was actually read.
   *
   * `resolveReplaySeedDraft` already maps `{ dialog: [] }` to `no_source_dialog`
   * and `null` to `unavailable`, and the same-Session Agent transition asks the
   * question AFTER stopping the source: a fresh empty Session answered
   * `unavailable` is stopped and then told the switch failed.
   */
  async function hydrateAgainst(
    handler: (url: URL, res: import('node:http').ServerResponse) => void,
    options?: Readonly<{ sessionId?: string; secret?: Uint8Array }>,
  ) {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method !== 'GET') {
        res.statusCode = 404;
        res.end();
        return;
      }
      handler(url, res);
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

    const { hydrateReplayDialogFromForkChain } = await import('./hydrateReplayDialogFromForkChain');
    return await hydrateReplayDialogFromForkChain({
      credentials: {
        token: 't',
        encryption: { type: 'legacy', secret: options?.secret ?? new Uint8Array(32).fill(1) },
      },
      startingSessionId: options?.sessionId ?? 'sess_empty_source',
      limit: 10,
      wantSynopsisText: false,
    });
  }

  const EMPTY_SOURCE_SESSION = {
    id: 'sess_empty_source',
    seq: 0,
    createdAt: 100,
    updatedAt: 100,
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

  it('reports a successfully read Session with no dialog as an empty dialog, not a failed hydration', async () => {
    const result = await hydrateAgainst((url, res) => {
      if (/^\/v2\/sessions\/sess_empty_source$/u.test(url.pathname)) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: EMPTY_SOURCE_SESSION }));
        return;
      }
      if (url.pathname === '/v1/sessions/sess_empty_source/messages') {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: [] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    expect(result).not.toBeNull();
    expect(result?.dialog).toEqual([]);
  });

  /**
   * A hole in the middle of the conversation is invisible: every unreadable row
   * is skipped with `continue` and the surviving dialog looks complete. The
   * hydrator is where the row-level count and the segment-level failure become
   * ONE fact the seed can state honestly.
   */
  it('reports the replay as incomplete when an examined row could not be read', async () => {
    const result = await hydrateAgainst((url, res) => {
      if (/^\/v2\/sessions\/sess_empty_source$/u.test(url.pathname)) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: EMPTY_SOURCE_SESSION }));
        return;
      }
      if (url.pathname === '/v1/sessions/sess_empty_source/messages') {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'readable' } } } },
            { seq: 2, createdAt: 2, content: { t: 'encrypted', c: 'bm90LWRlY3J5cHRhYmxl' } },
          ],
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    expect(result?.dialog.map((item) => item.text)).toEqual(['readable']);
    expect(result?.historyIncomplete).toBe(true);
  });

  it('does not report incompleteness when every examined row was read', async () => {
    const result = await hydrateAgainst((url, res) => {
      if (/^\/v2\/sessions\/sess_empty_source$/u.test(url.pathname)) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: EMPTY_SOURCE_SESSION }));
        return;
      }
      if (url.pathname === '/v1/sessions/sess_empty_source/messages') {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'readable' } } } },
          ],
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    expect(result?.dialog.map((item) => item.text)).toEqual(['readable']);
    expect(result?.historyIncomplete).toBe(false);
  });

  it('still reports a failed transcript retrieval as a failed hydration', async () => {
    // Control: the same empty result must NOT be produced when the transcript
    // page could not be read at all.
    const result = await hydrateAgainst((url, res) => {
      if (/^\/v2\/sessions\/sess_empty_source$/u.test(url.pathname)) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: EMPTY_SOURCE_SESSION }));
        return;
      }
      res.statusCode = 500;
      res.end();
    });

    expect(result).toBeNull();
  });

  /**
   * A legacy-secret Account has no per-Session data key: the Account secret IS
   * the content key, and `resolveSessionEncryptionContextFromCredentials` is the
   * one owner that already knows that. This hydrator asked only for `dataKey`
   * material, so a legacy-secret home marked every e2ee segment unavailable and
   * the whole hydration answered `null`.
   *
   * That is not cosmetic. The same-Session Agent transition asks this question
   * AFTER it has confirmed the source stopped, so that `null` surfaces as
   * `partially_applied / source_stopped / context_unavailable`: the Session's
   * Agent is stopped and only then does the switch fail.
   */
  it('opens an e2ee segment with the Account secret under legacy-secret credentials', async () => {
    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    const secret = new Uint8Array(32).fill(9);
    const legacySession = {
      ...EMPTY_SOURCE_SESSION,
      id: 'sess_legacy_e2ee',
      seq: 1,
      encryptionMode: 'e2ee',
      metadata: encodeBase64(encryptLegacy({ flavor: 'claude', path: '/tmp' }, secret)),
      // A legacy-secret Account publishes no per-Session DEK; the secret is the key.
      dataEncryptionKey: null,
    };

    const result = await hydrateAgainst((url, res) => {
      if (/^\/v2\/sessions\/sess_legacy_e2ee$/u.test(url.pathname)) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: legacySession }));
        return;
      }
      if (url.pathname === '/v1/sessions/sess_legacy_e2ee/messages') {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          messages: [{
            seq: 1,
            createdAt: 1,
            content: {
              t: 'encrypted',
              c: encodeBase64(encryptLegacy(
                { role: 'user', content: { type: 'text', text: 'LEGACY_SECRET_TURN' } },
                secret,
              )),
            },
          }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    }, { sessionId: 'sess_legacy_e2ee', secret });

    expect(result).not.toBeNull();
    expect(result?.dialog.map((item) => item.text)).toEqual(['LEGACY_SECRET_TURN']);
    // Opening the segment with the wrong key would skip the row and still
    // return an empty-but-successful hydration, so the seed would claim a
    // completeness it never had.
    expect(result?.historyIncomplete).toBe(false);
  });
});

/**
 * Character-budget retrieval (the seed window).
 *
 * The observed failure this replaces: one unfiltered page of 500 transcript
 * rows yielded 165 conversational lines and 25k characters against a 120k
 * budget — 21% of it — and ZERO user turns, because tool, thinking and
 * lifecycle rows all classify as `event` and were paying for the window. The
 * fix is a role-filtered window filled BACKWARDS against a character budget,
 * bounded by a request ceiling because the endpoint is shared and rate-limited.
 */
describe('hydrateReplayDialogFromForkChain — character-budget window', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let envScope = createEnvKeyScope([
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_HOME_DIR',
    'HAPPIER_REPLAY_SEED_MAX_TRANSCRIPT_REQUESTS',
  ]);

  beforeEach(async () => {
    envScope = createEnvKeyScope([
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_HOME_DIR',
      'HAPPIER_REPLAY_SEED_MAX_TRANSCRIPT_REQUESTS',
    ]);
    happyHomeDir = await createTempDir('happier-cli-replay-window-');
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

  const SESSION_ID = 'sess_window';

  function sessionRow(overrides?: Record<string, unknown>) {
    return {
      id: SESSION_ID,
      seq: 10_000,
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
      ...overrides,
    };
  }

  type Row = { seq: number; createdAt: number; messageRole: 'user' | 'agent' | 'event'; content: unknown };

  function textRow(seq: number, role: 'user' | 'agent', text: string): Row {
    return {
      seq,
      createdAt: 1_000 + seq,
      messageRole: role,
      content: { t: 'plain', v: { role, content: { type: 'text', text } } },
    };
  }

  function eventRow(seq: number, text: string): Row {
    return {
      seq,
      createdAt: 1_000 + seq,
      messageRole: 'event',
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text } } },
    };
  }

  async function run(params: Readonly<{
    rows: readonly Row[];
    session?: Record<string, unknown>;
    charBudget?: number | null;
    honorRoles?: boolean;
    env?: Record<string, string>;
    /**
     * Exclusive lower bound handed to the walk, as a native return does
     * (`AM-26`). The stub honors it the way the real endpoint does, so a
     * post-fetch filter cannot pass for a server-side bound.
     */
    afterSeqExclusive?: number;
    /**
     * When set, the starting Session declares a fork parent and the parent is
     * served too — so "the chain was not walked" is an observable fact rather
     * than the absence of a route.
     */
    parentSessionId?: string;
    parentRows?: readonly Row[];
  }>) {
    const requests: Array<{ roles: string | null; beforeSeq: number | null; afterSeq: number | null; limit: number }> = [];
    const parentRequests: Array<'session' | 'messages'> = [];
    const sorted = [...params.rows].sort((a, b) => a.seq - b.seq);
    const parentSorted = [...(params.parentRows ?? [])].sort((a, b) => b.seq - a.seq);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === `/v2/sessions/${SESSION_ID}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow(params.session) }));
        return;
      }
      if (params.parentSessionId && url.pathname === `/v2/sessions/${params.parentSessionId}`) {
        parentRequests.push('session');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          session: {
            ...sessionRow(),
            id: params.parentSessionId,
            metadata: JSON.stringify({ flavor: 'claude', path: '/tmp' }),
          },
        }));
        return;
      }
      if (params.parentSessionId && url.pathname === `/v1/sessions/${params.parentSessionId}/messages`) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        parentRequests.push('messages');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          messages: parentSorted,
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        }));
        return;
      }
      if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        const rolesRaw = url.searchParams.get('roles');
        const beforeSeqRaw = url.searchParams.get('beforeSeq');
        const afterSeqRaw = url.searchParams.get('afterSeq');
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '150', 10);
        const beforeSeq = beforeSeqRaw ? Number.parseInt(beforeSeqRaw, 10) : null;
        const afterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : null;
        requests.push({ roles: rolesRaw, beforeSeq, afterSeq, limit });

        const requested = rolesRaw ? rolesRaw.split(',') : null;
        const eligible = sorted
          .filter((r) => (beforeSeq == null ? true : r.seq < beforeSeq))
          .filter((r) => (afterSeq == null ? true : r.seq > afterSeq))
          .filter((r) => (params.honorRoles === false || !requested ? true : requested.includes(r.messageRole)));
        const picked = eligible.slice().sort((a, b) => b.seq - a.seq).slice(0, limit);
        const hasMore = eligible.length > picked.length;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          messages: picked,
          hasMore,
          nextBeforeSeq: hasMore && picked.length > 0 ? picked[picked.length - 1]!.seq : null,
          nextAfterSeq: null,
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve server address');

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
      ...(params.env ?? {}),
    });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateReplayDialogFromForkChain } = await import('./hydrateReplayDialogFromForkChain');
    const result = await hydrateReplayDialogFromForkChain({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      startingSessionId: SESSION_ID,
      limit: 5,
      wantSynopsisText: false,
      ...(params.charBudget === undefined ? {} : { planTranscriptCharBudget: () => params.charBudget ?? null }),
      ...(params.afterSeqExclusive === undefined ? {} : { afterSeqExclusive: params.afterSeqExclusive }),
    });
    return { result, requests, messageRequests: requests, parentRequests };
  }

  it('asks the server for conversational roles only, so tool and thinking rows never pay for the window', async () => {
    const { result, messageRequests } = await run({
      rows: [
        textRow(1, 'user', 'the actual instruction'),
        eventRow(2, 'tool result envelope'),
        textRow(3, 'agent', 'the answer'),
      ],
      charBudget: 100_000,
    });

    expect(messageRequests.length).toBeGreaterThan(0);
    for (const request of messageRequests) {
      expect(request.roles).toBe('user,agent');
    }
    expect(result?.dialog.map((item) => item.text)).toEqual(['the actual instruction', 'the answer']);
  });

  it('pages backwards until the character budget is met, not until a row count is', async () => {
    // 40 turns of ~60 chars each against a 5-row page: a row-count window sees
    // 5 of them, a character budget walks back until ~600 characters are held.
    const rows = Array.from({ length: 40 }, (_unused, index) =>
      textRow(index + 1, index % 2 === 0 ? 'user' : 'agent', `turn-${index + 1} `.padEnd(50, 'z')));

    const wide = await run({ rows, charBudget: 600 });
    expect(wide.result).not.toBeNull();
    expect(wide.result!.dialog.length).toBeGreaterThan(5);
    expect(wide.messageRequests.length).toBeGreaterThan(1);
    // Newest end first, and it stops rather than overshooting the plan.
    expect(wide.result!.dialog[wide.result!.dialog.length - 1]!.text).toContain('turn-40');
    const carried = wide.result!.dialog.reduce((total, item) => total + item.text.length + 8, 0);
    expect(carried).toBeLessThanOrEqual(600);

    // Discriminating control: a small budget must stop inside the FIRST page.
    const narrow = await run({ rows, charBudget: 130 });
    expect(narrow.messageRequests.length).toBe(1);
    expect(narrow.result!.dialog.length).toBeLessThan(3);
  });

  it('stops at the request ceiling and says so rather than implying it reached the start', async () => {
    const rows = Array.from({ length: 200 }, (_unused, index) =>
      textRow(index + 1, 'agent', `turn-${index + 1} `.padEnd(50, 'z')));

    const capped = await run({
      rows,
      charBudget: 200_000,
      env: { HAPPIER_REPLAY_SEED_MAX_TRANSCRIPT_REQUESTS: '3' },
    });
    // The ceiling is per hydration and bounds the WALK. The pinned last-user
    // lookup is a separate single-row request and is allowed past it, because a
    // seed without the instruction it is serving is the failure being fixed.
    expect(capped.messageRequests.filter((request) => request.roles === 'user,agent').length).toBe(3);
    expect(capped.messageRequests.filter((request) => request.roles === 'user').length).toBeLessThanOrEqual(1);
    expect(capped.result!.reachedSourceStart).toBe(false);
    // Not a hole: nothing was unreadable, the walk simply stopped.
    expect(capped.result!.historyIncomplete).toBe(false);

    // Discriminating control: given room to finish, it reports reaching the start.
    const complete = await run({ rows: rows.slice(0, 4), charBudget: 200_000 });
    expect(complete.result!.reachedSourceStart).toBe(true);
  });

  it('collapses an adjacent duplicate turn instead of spending the budget on it twice', async () => {
    const rows = [
      textRow(1, 'user', 'do the thing'),
      textRow(2, 'agent', 'Working on it'),
      textRow(3, 'agent', 'Working on it, and here is the rest of the answer'),
      textRow(4, 'agent', 'Something else entirely'),
    ];
    const { result } = await run({ rows, charBudget: 100_000 });
    expect(result!.dialog.map((item) => item.text)).toEqual([
      'do the thing',
      'Working on it, and here is the rest of the answer',
      'Something else entirely',
    ]);
  });

  it('carries the newest user turn even when the window is entirely agent output', async () => {
    const rows = [
      textRow(1, 'user', 'THE INSTRUCTION THAT FRAMES EVERYTHING'),
      ...Array.from({ length: 30 }, (_unused, index) =>
        textRow(index + 2, 'agent', `agent-${index} `.padEnd(60, 'q'))),
    ];
    const { result } = await run({ rows, charBudget: 300 });
    expect(result!.dialog.some((item) => item.role === 'User')).toBe(false);
    expect(result!.lastUserDialogItem?.text).toBe('THE INSTRUCTION THAT FRAMES EVERYTHING');

    // Discriminating control: when the window already carries the newest user
    // turn, no extra lookup is needed and the same turn is reported.
    const inWindow = await run({
      rows: [textRow(1, 'agent', 'older'), textRow(2, 'user', 'recent instruction')],
      charBudget: 100_000,
    });
    expect(inWindow.result!.lastUserDialogItem?.text).toBe('recent instruction');
  });

  /**
   * Native return (`AM-26`): the returning Agent already holds everything up to
   * the seq it last saw, so the walk starts just above it.
   */
  it('bounds the walk at the returning Agent departure seq with a query the real route accepts', async () => {
    const rows = Array.from({ length: 10 }, (_unused, index) =>
      textRow(index + 1, index % 2 === 0 ? 'user' : 'agent', `turn-${index + 1}`));

    const { result, messageRequests, parentRequests } = await run({
      rows,
      charBudget: 100_000,
      afterSeqExclusive: 6,
      parentSessionId: 'sess_window_parent',
      parentRows: [textRow(1, 'user', 'parent turn')],
      session: {
        metadata: JSON.stringify({
          flavor: 'claude',
          path: '/tmp',
          forkV1: { v: 1, parentSessionId: 'sess_window_parent', parentCutoffSeqInclusive: 1 },
        }),
      },
    });

    // Every page is asked for with a query the REAL route accepts. `beforeSeq`
    // and `afterSeq` are mutually exclusive on
    // `GET /v1/sessions/:sessionId/messages`, and this walk pages backwards, so
    // the bound may never travel as `afterSeq`. Sending the pair 400'd every
    // bounded fetch live while the double answered 200.
    expect(messageRequests.length).toBeGreaterThan(0);
    for (const request of messageRequests) {
      expect(request.beforeSeq).not.toBeNull();
      expect(request.afterSeq).toBeNull();
    }
    // …and the bound is still a bound, not merely a post-hoc filter over a walk
    // to the start of the Session: nothing below it is ever asked for, so the
    // request ceiling is not spent on history the reader already holds.
    expect(Math.min(...messageRequests.map((request) => request.beforeSeq ?? Number.POSITIVE_INFINITY)))
      .toBeGreaterThan(6);
    expect(result?.dialog.map((item) => item.text)).toEqual([
      'turn-7', 'turn-8', 'turn-9', 'turn-10',
    ]);

    // The bound lives in THIS Session's seq space, so a parent segment is below
    // it by construction. The chain ends here — it is not walked and then
    // filtered.
    expect(parentRequests).toEqual([]);

    // Reaching the bound is NATURAL termination. The seed must not claim a loss
    // that does not exist: the returning Agent still holds everything below it.
    expect(result?.reachedSourceStart).toBe(true);
    expect(result?.historyIncomplete).toBe(false);
  });

  it('bounds the pinned last-user lookup with a query the real route accepts', async () => {
    // The window is all agent output, so the pinned lookup fires. A user turn
    // from BEFORE the Agent left is already in its own conversation, and
    // pinning it as "the latest instruction" would restate a served ask.
    const rows = [
      textRow(1, 'user', 'THE ASK THE RETURNING AGENT ALREADY SERVED'),
      ...Array.from({ length: 4 }, (_unused, index) => textRow(index + 2, 'agent', `away-${index}`)),
    ];

    const { result, messageRequests } = await run({
      rows,
      charBudget: 100_000,
      afterSeqExclusive: 1,
    });

    // The pinned lookup is the SECOND fetch on the native-return path, and the
    // second one that used to pair `beforeSeq` with `afterSeq`. Both fetches
    // have to carry the bound themselves.
    expect(messageRequests.some((request) => request.roles === 'user')).toBe(true);
    for (const request of messageRequests) {
      expect(request.beforeSeq).not.toBeNull();
      expect(request.afterSeq).toBeNull();
    }
    expect(result?.lastUserDialogItem).toBeNull();

    // Discriminating control: unbounded, the same lookup finds that same turn.
    const unbounded = await run({ rows, charBudget: 100_000 });
    expect(unbounded.result?.lastUserDialogItem?.text).toBe('THE ASK THE RETURNING AGENT ALREADY SERVED');
  });

  it('walks the whole fork chain when no departure bound is given', async () => {
    // The structurally impossible case at the retrieval layer: with no record
    // there is no bound, so nothing narrows the walk.
    const { result, messageRequests, parentRequests } = await run({
      rows: [textRow(2, 'user', 'child turn')],
      charBudget: 100_000,
      parentSessionId: 'sess_window_parent',
      parentRows: [textRow(1, 'user', 'parent turn')],
      session: {
        metadata: JSON.stringify({
          flavor: 'claude',
          path: '/tmp',
          forkV1: { v: 1, parentSessionId: 'sess_window_parent', parentCutoffSeqInclusive: 1 },
        }),
      },
    });

    for (const request of messageRequests) {
      expect(request.afterSeq).toBeNull();
    }
    expect(parentRequests).toContain('messages');
    expect(result?.dialog.map((item) => item.text)).toEqual(['parent turn', 'child turn']);
  });

  it('reports the Session title so the seed can state what the Session is for', async () => {
    const { result } = await run({
      rows: [textRow(1, 'user', 'hello')],
      session: { metadata: JSON.stringify({ flavor: 'claude', path: '/tmp', summary: { text: 'Port the decoder', updatedAt: 5 } }) },
      charBudget: 100_000,
    });
    expect(result!.sourceTitleText).toBe('Port the decoder');

    const untitled = await run({ rows: [textRow(1, 'user', 'hello')], charBudget: 100_000 });
    expect(untitled.result!.sourceTitleText).toBeNull();
  });
});
