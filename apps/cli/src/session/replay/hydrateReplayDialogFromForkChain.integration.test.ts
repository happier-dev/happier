import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildHappierReplayPromptFromDialog } from '@happier-dev/agents';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { respondTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

/**
 * The hydrator resolves the Account's encryption currentness before walking the
 * chain and treats an unavailable answer as a hard failure, so every fake
 * server in this file has to answer it. Kept in one place so a route added to
 * the real client does not silently red the whole suite again.
 */
function respondAccountEncryptionCurrentness(url: URL, res: import('node:http').ServerResponse): boolean {
  if (url.pathname !== '/v1/account/encryption/currentness') return false;
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
  }));
  return true;
}

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

  it('hydrates a layout-v1 fork chain from the owner metadata envelope', async () => {
    const childSessionId = 'sess_layout_v1_child';
    const parentSessionId = 'sess_layout_v0_parent';
    const secret = new Uint8Array(32).fill(1);
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      history: {
        forkV1: {
          v: 1,
          parentSessionId,
          parentCutoffSeqInclusive: 1,
          createdAtMs: 200,
          strategy: 'replay',
        },
      },
    });
    const sessions = new Map([
      [childSessionId, {
        id: childSessionId,
        seq: 1,
        createdAt: 200,
        updatedAt: 201,
        active: false,
        activeAt: 0,
        archivedAt: null,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        metadataVersion: 0,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
        agentState: null,
        agentStateVersion: 0,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        share: null,
      }],
      [parentSessionId, {
        id: parentSessionId,
        seq: 1,
        createdAt: 100,
        updatedAt: 101,
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
      }],
    ]);
    const messages = new Map([
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
      if (respondAccountEncryptionCurrentness(url, res)) return;
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
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      startingSessionId: childSessionId,
      limit: 10,
      wantSynopsisText: false,
    });

    expect(result?.dialog.map((item) => item.text)).toEqual([
      'parent turn',
      'child turn',
    ]);
    /**
     * Every row says which Session's seq space its `seq` is numbered in.
     *
     * This walk is the one place two Sessions' seq spaces meet, and after the
     * createdAt sort the parent's row and the child's are indistinguishable by
     * number alone — here both are `seq: 1`. The replay seed's range claim is a
     * span in ONE space and its paging cursor is executed against ONE Session,
     * so without this fact the seed can hand the child a cursor taken from the
     * parent's numbering and the target skips every row above it, forever.
     */
    expect(result?.dialog.map((item) => ({ text: item.text, seq: item.seq, sessionId: item.sessionId }))).toEqual([
      { text: 'parent turn', seq: 1, sessionId: parentSessionId },
      { text: 'child turn', seq: 1, sessionId: childSessionId },
    ]);
  });

  it('does not carry media from rows rejected by the replay window', async () => {
    const sessionId = 'sess_media_window';
    const retainedPath = '.happier/uploads/messages/sess_media_window/message-2/retained.png';
    const omittedPath = '.happier/uploads/messages/sess_media_window/message-1/omitted.png';
    const media = (path: string) => ({
      kind: 'session_media.v1',
      payload: { media: [{ category: 'attachment', path }] },
    });
    const session = {
      id: sessionId,
      seq: 2,
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
    const messages = [
      {
        seq: 1,
        createdAt: 1,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'omitted transcript row' },
            meta: { happier: media(omittedPath) },
          },
        },
      },
      {
        seq: 2,
        createdAt: 2,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'retained transcript row' },
            meta: { happier: media(retainedPath) },
          },
        },
      },
    ];

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (respondAccountEncryptionCurrentness(url, res)) return;
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages }));
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
      limit: 10,
      maxDialogItems: 1,
      wantSynopsisText: false,
    });

    expect(result?.dialog.map((item) => item.text)).toEqual(['retained transcript row']);
    expect(result?.referencedSessionMediaWorkspacePaths).toEqual([retainedPath]);
  });

  /**
   * Two rows on opposite sides of a fork boundary can carry the SAME timestamp:
   * the fork copies nothing, so the parent's last turn and the child's first are
   * independent writes that a busy second puts in the same millisecond.
   *
   * `createdAt` alone is therefore not a total order, and the walk collects
   * child-segment-first — so a stable sort that leaves ties alone emits the
   * child's turn BEFORE the parent turn it answered. The target then reads the
   * conversation out of order and treats an answer as the question.
   */
  it('orders a fork boundary parent-before-child when both rows share a timestamp', async () => {
    const childSessionId = 'sess_tie_child';
    const parentSessionId = 'sess_tie_parent';
    const secret = new Uint8Array(32).fill(1);
    const SHARED_CREATED_AT = 500;
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      history: {
        forkV1: {
          v: 1,
          parentSessionId,
          parentCutoffSeqInclusive: 1,
          createdAtMs: SHARED_CREATED_AT,
          strategy: 'replay',
        },
      },
    });
    const baseSession = {
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };
    const sessions = new Map([
      [childSessionId, {
        ...baseSession,
        id: childSessionId,
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      }],
      [parentSessionId, {
        ...baseSession,
        id: parentSessionId,
        metadata: JSON.stringify({ flavor: 'claude', path: '/tmp' }),
      }],
    ]);
    const messages = new Map([
      [childSessionId, [{
        seq: 1,
        createdAt: SHARED_CREATED_AT,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'child answer' } } },
      }]],
      [parentSessionId, [{
        seq: 1,
        createdAt: SHARED_CREATED_AT,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'parent question' } } },
      }]],
    ]);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (respondAccountEncryptionCurrentness(url, res)) return;
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
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      startingSessionId: childSessionId,
      limit: 10,
      wantSynopsisText: false,
    });

    expect(result?.dialog.map((item) => item.text)).toEqual([
      'parent question',
      'child answer',
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
      if (respondAccountEncryptionCurrentness(url, res)) return;

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
      if (respondAccountEncryptionCurrentness(url, res)) return;

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
      if (respondAccountEncryptionCurrentness(url, res)) return;

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

  it('prefers the latest synopsis system record before legacy transcript artifacts', async () => {
    const sessionId = 'sess_plain_chain_system_record';

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

    const rows = Array.from({ length: 400 }, (_, index) => ({
      seq: index + 1,
      createdAt: 1000 + index + 1,
      content: index === 399
        ? {
            t: 'plain' as const,
            v: {
              role: 'agent',
              content: { type: 'text', text: '[memory]' },
              meta: {
                happier: {
                  kind: 'session_synopsis.v1',
                  payload: { v: 1, seqTo: 400, updatedAtMs: 9998, synopsis: 'LEGACY_TRANSCRIPT_SYNOPSIS_STALE' },
                },
              },
            },
          }
        : { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: `u${index + 1}` } } },
    }));

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (respondAccountEncryptionCurrentness(url, res)) return;

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
   * `unavailable` is stopped and then told the switch failed. That is the most
   * likely first-run moment to try the feature and the one case that trivially
   * cannot fail.
   */
  async function hydrateAgainst(
    handler: (url: URL, res: import('node:http').ServerResponse) => void,
    options?: Readonly<{ sessionId?: string; secret?: Uint8Array }>,
  ) {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (respondAccountEncryptionCurrentness(url, res)) return;
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
   * material, so every e2ee segment of a legacy-secret Account was marked
   * unavailable and the whole hydration answered `null`.
   *
   * That is not cosmetic. The same-Session Agent transition asks this question
   * AFTER it has confirmed the source stopped, so `null` arrives as
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
    afterSeqExclusive?: number;
    env?: Record<string, string>;
    /** Fail every transcript page request after this many have succeeded. */
    failMessageRequestsAfter?: number;
  }>) {
    const requests: Array<{
      roles: string | null;
      beforeSeq: number | null;
      afterSeq: number | null;
      limit: number;
    }> = [];
    const sorted = [...params.rows].sort((a, b) => a.seq - b.seq);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (respondAccountEncryptionCurrentness(url, res)) return;
      if (url.pathname === `/v2/sessions/${SESSION_ID}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow(params.session) }));
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

        if (
          typeof params.failMessageRequestsAfter === 'number'
          && requests.length > params.failMessageRequestsAfter
        ) {
          res.statusCode = 500;
          res.end();
          return;
        }

        const requested = rolesRaw ? rolesRaw.split(',') : null;
        const eligible = sorted
          .filter((r) => (beforeSeq == null ? true : r.seq < beforeSeq))
          // The real route supports `afterSeq` only on its own — paired with
          // `beforeSeq` it answers 400, which the guard above now enforces here
          // too. This filter therefore only ever runs for a forward query.
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
    return { result, requests, messageRequests: requests };
  }

  it('bounds the walk at the returning Agent’s own departure and calls that the START of the source', async () => {
    // `AM-26`. The Agent resumed its own native conversation, so everything at
    // or below seq 20 is already in its context. Re-sending it spends the whole
    // budget restating what the reader holds.
    const rows = Array.from({ length: 30 }, (_unused, index) =>
      textRow(index + 1, index % 2 === 0 ? 'user' : 'agent', `turn-${index + 1}`));

    const { result, messageRequests } = await run({
      rows,
      charBudget: 100_000,
      afterSeqExclusive: 20,
    });

    expect(result?.dialog.map((item) => item.text)).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `turn-${index + 21}`),
    );
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
      .toBeGreaterThan(20);
    // Reaching the bound is the natural end of what this walk was asked for. A
    // seed that reported it as a truncation would tell the returning Agent that
    // history is missing when nothing is.
    expect(result?.reachedSourceStart).toBe(true);
    expect(result?.historyIncomplete).toBe(false);
  });

  /**
   * A LATER page that fails is not a budget stop, and the difference is a
   * statement made to the target Agent. `reachedSourceStart: false` alone makes
   * the framer print "earlier messages were not retrieved to fit the context
   * budget" — a false explanation for a hole an I/O failure tore. The
   * incompleteness signal already carries "part of this could not be read", and
   * the framer already renders it, so a failed page must raise it.
   */
  it('reports a failed later page as incomplete history, not as a budget stop', async () => {
    const rows = Array.from({ length: 30 }, (_unused, index) =>
      textRow(index + 1, index % 2 === 0 ? 'user' : 'agent', `turn-${index + 1}`));

    // The page size is 5, so the first page succeeds and the second fails: the
    // walk has real rows in hand and still cannot see the rest of the source.
    const { result } = await run({ rows, charBudget: 100_000, failMessageRequestsAfter: 1 });

    expect(result?.dialog.length).toBeGreaterThan(0);
    expect(result?.reachedSourceStart).toBe(false);
    expect(result?.historyIncomplete).toBe(true);

    // The booleans are not the contract; the SENTENCE the target Agent reads
    // is, and asserting only the booleans is exactly why a false explanation
    // survived here. Composed the way `resolveReplaySeedDraft` composes it —
    // `historyIncomplete` straight through, `windowTruncated` from
    // `reachedSourceStart === false` — so a framer that blames the budget for
    // this loss reds on the rendered prompt itself.
    const rendered = buildHappierReplayPromptFromDialog({
      previousSessionId: SESSION_ID,
      strategy: 'recent_messages',
      recentMessagesCount: null,
      dialog: result!.dialog,
      historyIncomplete: result!.historyIncomplete,
      windowTruncated: result!.reachedSourceStart === false,
      maxPromptChars: 200_000,
    });
    expect(rendered).toContain('could not be read');
    expect(rendered).toContain('[earlier messages were not retrieved]');
    // No budget claim of ANY kind survives: the walk stopped on a 500, and
    // nothing here was dropped to fit anything.
    expect(rendered).not.toContain('to fit the context budget');
  });

  it('still reports a budget stop above the bound as not having reached the start', async () => {
    const rows = Array.from({ length: 40 }, (_unused, index) =>
      textRow(index + 1, index % 2 === 0 ? 'user' : 'agent', `turn-${index + 1} `.padEnd(50, 'z')));

    const { result } = await run({ rows, charBudget: 200, afterSeqExclusive: 5 });

    expect(result?.reachedSourceStart).toBe(false);
    const oldest = Math.min(...(result?.dialog ?? []).map((item) => item.seq ?? Number.POSITIVE_INFINITY));
    expect(oldest).toBeGreaterThan(6);
  });

  it('bounds the pinned last-user lookup with a query the real route accepts', async () => {
    // The window is all agent output, so the pinned last-user lookup fires —
    // the SECOND fetch on the native-return path, and the second one that used
    // to pair `beforeSeq` with `afterSeq`. `GET /v1/sessions/:sessionId/messages`
    // rejects that pair (`beforeSeq and afterSeq are mutually exclusive`, 400),
    // so both fetches have to carry the bound themselves.
    const rows = [
      textRow(1, 'user', 'THE ASK THE RETURNING AGENT ALREADY SERVED'),
      ...Array.from({ length: 4 }, (_unused, index) => textRow(index + 2, 'agent', `away-${index}`)),
    ];

    const { result, messageRequests } = await run({ rows, charBudget: 100_000, afterSeqExclusive: 1 });

    // The pinned lookup ran…
    expect(messageRequests.some((request) => request.roles === 'user')).toBe(true);
    // …and every request it made — walk and lookup alike — is legal.
    for (const request of messageRequests) {
      expect(request.beforeSeq).not.toBeNull();
      expect(request.afterSeq).toBeNull();
    }
    // The bound still holds where it matters: a user turn the returning Agent
    // already served must not come back as "the latest instruction".
    expect(result?.lastUserDialogItem).toBeNull();

    // Discriminating control — unbounded, that same lookup finds that same turn,
    // so the null above is the bound working and not the lookup being broken.
    const unbounded = await run({ rows, charBudget: 100_000 });
    expect(unbounded.result?.lastUserDialogItem?.text).toBe('THE ASK THE RETURNING AGENT ALREADY SERVED');
  });

  it('sends no afterSeq at all when there is no bound', async () => {
    // The fresh-target path must be byte-identical to the pre-change walk: an
    // absent bound is never a `0` bound and never a `NaN` query parameter.
    const { messageRequests } = await run({
      rows: [textRow(1, 'user', 'hello'), textRow(2, 'agent', 'hi')],
      charBudget: 100_000,
    });

    expect(messageRequests.length).toBeGreaterThan(0);
    for (const request of messageRequests) {
      expect(request.afterSeq).toBeNull();
    }
  });

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
