import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { deriveBoxPublicKeyFromSeed, deriveBoxSecretKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  parseAccountStoredContentCompatibilityHttpHeadersV1, parseAccountStoredContentCompatibilitySocketAuthV1,
  RPC_METHODS, sealEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0, wrapApiTokenEncryptionAccessV1,
  SessionSharedMetadataV1Schema, type SessionSharedMetadataV1 } from '@happier-dev/protocol';

import { connect } from '../index.js';
import type { HappierSessionController } from './types.js';
import type { AgentState } from '@happier-dev/session-core';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { createSessionContentEncryption } from './openSessionDataKey.js';

const TOKEN_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = `hap_v1_${TOKEN_ID}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function row(seq: number, text: string, updatedAt = seq) {
  return { id: `row-${seq}`, seq, localId: null, sidechainId: null, messageRole: 'user',
    createdAt: seq, updatedAt, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } } };
}

// Rendered IDs belong to session-core; pending permissions also materialize
// canonical synthetic rows. Durable row provenance is the stable wire identity.
function durableRows(controller: HappierSessionController) {
  const transcript = controller.getSnapshot().transcript;
  return transcript.messageIdsOldestFirst.map((id) => transcript.messagesById[id]!)
    .filter((message) => message.realID?.startsWith('row-') === true);
}
function durableIds(controller: HappierSessionController) {
  return durableRows(controller).map((message) => message.realID);
}

async function fixture(encryptionMode: 'plain' | 'e2ee' = 'plain', contentCredential = false) {
  let rows = [row(1, 'first')];
  let state: AgentState = { requests: { permission: { tool: 'Bash', arguments: { command: 'echo hi' }, createdAt: 1 } } };
  let stateVersion = 1;
  let revision = 0;
  let unrelatedChangePage = false;
  let cursorGone = false;
  let rejectRpc = false;
  let offline = false;
  let active = true;
  let inactiveEmptyReads = 0;
  let storedFailure: 'corrupt' | 'mode_mismatch' | null = null;
  let openedFailure = false;
  let changeHint: Record<string, unknown> = {};
  let deactivateAtInitialCursor = false;
  let holdHistory = false;
  let requireCompatibility = false;
  let sharedMetadata: SessionSharedMetadataV1 | null = null;
  let sharedMetadataVersion = 1;
  const heldHistory: (() => void)[] = [];
  const rpc: unknown[] = [];
  const actions: Readonly<{ actionId: string; input: Record<string, unknown> }>[] = [];
  const followReads: { cursor: number; leaseId: string | null; ids: string[]; nextCursor: string; at: number }[] = [];
  const sessions: Socket[] = [];
  const requests: string[] = [];
  const actionRevisions = new Map<string, number>();
  const waitingActions = new Set<() => void>();
  const accountSeed = new Uint8Array(32).fill(9);
  const dataKey = new Uint8Array(32).fill(17);
  const context = { serverIdentityId: 'srv_live', accountId: 'account-1', tokenId: TOKEN_ID,
    contentPublicKey: encodeBase64(deriveBoxPublicKeyFromSeed(accountSeed), 'base64') };
  const wrappingSecret = new Uint8Array(32).fill(7);
  const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret, contentPrivateKey: deriveBoxSecretKeyFromSeed(accountSeed),
    randomBytes: (length) => new Uint8Array(length).fill(3) });
  const credential = formatAccountApiTokenCredentialV1({ bearer: TOKEN, wrappingSecret: encodeBase64(wrappingSecret, 'base64url'),
    serverIdentityId: context.serverIdentityId, accountId: context.accountId, contentPublicKey: context.contentPublicKey });
  let dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
    recipientPublicKey: deriveBoxPublicKeyFromSeed(accountSeed), randomBytes: (length) => new Uint8Array(length).fill(4) }), 'base64');
  const storedState = async (value: unknown) => contentCredential
    ? encodeBase64(await sealSessionDataKeyBundleV0(value, dataKey), 'base64') : JSON.stringify(value);
  const wireRow = async (entry: ReturnType<typeof row>) => {
    if (storedFailure === 'corrupt') return { ...entry, content: { t: 'encrypted', c: encodeBase64(new Uint8Array(32), 'base64') } };
    if (storedFailure === 'mode_mismatch') return contentCredential ? entry : { ...entry, content: { t: 'encrypted', c: 'opaque-wrong-mode' } };
    return contentCredential ? { ...entry, content: { t: 'encrypted', c: encodeBase64(await sealSessionDataKeyBundleV0(entry.content.v, dataKey), 'base64') } } : entry;
  };
  const server: HttpServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://test');
    requests.push(url.pathname + url.search);
    response.setHeader('content-type', 'application/json');
    if (offline) { response.statusCode = 503; response.end('{}'); return; }
    if (url.pathname === '/v2/sessions/session-1') {
      const compatibility = parseAccountStoredContentCompatibilityHttpHeadersV1(request.headers);
      if (requireCompatibility && (compatibility.status !== 'valid'
        || compatibility.declaration.protocolVersion < CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION)) {
        response.statusCode = 426; response.end(JSON.stringify({ error: 'client-update-required' })); return;
      }
      response.end(JSON.stringify({ session: { id: 'session-1', encryptionMode, active,
        seq: rows.at(-1)?.seq ?? 0, createdAt: 1, updatedAt: 1, activeAt: 1,
        dataEncryptionKey: encryptionMode === 'e2ee' ? dataEncryptionKey : null,
        metadata: sharedMetadata ? encodeBase64(await sealSessionDataKeyBundleV0(sharedMetadata, dataKey), 'base64')
          : await storedState({ path: '/work', host: 'test' }), metadataVersion: sharedMetadataVersion,
        ...(sharedMetadata ? { metadataLayoutVersion: 1, share: { accessLevel: 'edit', canApprovePermissions: true } } : {}),
        agentState: sharedMetadata ? null : await storedState(state), agentStateVersion: stateVersion,
        effectiveAccess: { v: 1, level: sharedMetadata ? 'edit' : 'owner',
          sources: sharedMetadata ? [{ kind: 'direct', shareId: 'share-1' }] : [{ kind: 'owner' }], capabilities: {
          readTranscript: true, submitAgentInput: true, editSessionRecords: true, approveRuntimePermissions: true,
          manageAccess: !sharedMetadata, managePermissionDelegation: !sharedMetadata, managePublicLink: !sharedMetadata, archiveSession: !sharedMetadata,
          renameSession: !sharedMetadata, assignResponsibility: !sharedMetadata, stopSession: !sharedMetadata, deleteSession: !sharedMetadata,
        } } } }));
    } else if (url.pathname.endsWith('/encryption-access')) {
      response.end(JSON.stringify({ v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess }));
    } else if (url.pathname === '/v2/cursor') {
      if (deactivateAtInitialCursor) { deactivateAtInitialCursor = false; active = false; revision++; }
      response.end(JSON.stringify({ cursor: revision, changesFloor: 0 }));
    } else if (url.pathname === '/v2/changes') {
      if (cursorGone) { cursorGone = false; response.statusCode = 410; response.end(JSON.stringify({ error: 'cursor-gone', currentCursor: revision })); return; }
      const after = Number(url.searchParams.get('after') ?? 0);
      // The server pages raw Account changes before applying the Session
      // selector: an entirely filtered page still advances its raw cursor.
      if (unrelatedChangePage && after < 200) {
        response.end(JSON.stringify({ changes: [], nextCursor: 200 })); return;
      }
      response.end(JSON.stringify({ changes: revision > after ? [{ cursor: revision, changedAt: 100, kind: 'session', entityId: 'session-1',
        hint: changeHint }] : [], nextCursor: Math.max(after, revision) }));
    } else if (url.pathname === '/v1/sessions/session-1/messages') {
      const after = Number(url.searchParams.get('afterSeq') ?? 0);
      const before = Number(url.searchParams.get('beforeSeq') ?? Infinity);
      const selected = await Promise.all(rows.filter((entry) => entry.seq > after && entry.seq < before).map(wireRow));
      const send = () => response.end(JSON.stringify({ messages: selected, hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }));
      if (holdHistory) heldHistory.push(send); else send();
    } else if (url.pathname.startsWith('/v1/actions/')) {
      let text = '';
      for await (const bytes of request) text += String(bytes);
      // This is the network producer boundary, not a replacement for SDK parsing.
      const body = JSON.parse(text) as { requestId?: string; input: Record<string, unknown> };
      const actionId = decodeURIComponent(url.pathname.slice('/v1/actions/'.length));
      actions.push({ actionId, input: body.input });
      let result: unknown = { ok: true };
      if (actionId === 'transcript.follow') {
        const after = Number(body.input.cursor ?? 0);
        const leaseId = String(body.input.leaseId);
        if (body.input.waitForChanges === true && !rows.some((entry) => entry.seq > after)
          && stateVersion <= Number(body.input.agentStateVersion ?? stateVersion)
          && (!sharedMetadata || sharedMetadataVersion <= Number(body.input.sharedMetadataVersion ?? sharedMetadataVersion))
          && revision <= (actionRevisions.get(leaseId) ?? revision)) {
          await new Promise<void>((resolve) => {
            const wake = () => { waitingActions.delete(wake); response.off('close', wake); resolve(); };
            waitingActions.add(wake);
            response.once('close', wake);
          });
          if (response.destroyed) return;
        }
        const previousRevision = actionRevisions.get(leaseId) ?? revision;
        actionRevisions.set(leaseId, revision);
        const items = rows.filter((entry) => entry.seq > after).map((entry) => openedFailure && entry.seq === 1
          ? { ...entry, content: { t: 'plain', v: null }, openFailure: 'corrupt_or_unopenable' } : entry);
        followReads.push({ cursor: after, leaseId: typeof body.input.leaseId === 'string' ? body.input.leaseId : null,
          ids: items.map((entry) => entry.id), nextCursor: String(items.at(-1)?.seq ?? after), at: Date.now() });
        if (!active && items.length === 0) inactiveEmptyReads++;
        result = { ok: true, leaseId: body.input.leaseId, projection: 'openedMessagesV1', items,
          nextCursor: String(items.at(-1)?.seq ?? after), truncated: false,
          agentState: stateVersion > Number(body.input.agentStateVersion ?? -1) ? { version: stateVersion, value: sharedMetadata ? null : state } : null,
          sharedMetadata: sharedMetadata && sharedMetadataVersion > Number(body.input.sharedMetadataVersion ?? -1)
            ? { version: sharedMetadataVersion, value: sharedMetadata } : null,
          changes: revision > previousRevision ? changeHint.updatedMessageId
            ? [{ kind: 'revision', messageId: changeHint.updatedMessageId, seq: changeHint.updatedMessageSeq }]
            : [{ kind: 'session' }] : [] };
      } else if (actionId === 'transcript.unfollow') {
        result = { ok: true, released: true };
      } else if (actionId === 'session.status.get') {
        result = { session: { active } };
      }
      response.end(JSON.stringify({ v: 1, actionId, ...(body.requestId ? { requestId: body.requestId } : {}), execution: { ok: true, result } }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  const io = new Server(server, { path: '/v1/updates/' });
  io.use((socket, next) => {
    const compatibility = parseAccountStoredContentCompatibilitySocketAuthV1(socket.handshake.auth);
    if (requireCompatibility && (compatibility.status !== 'valid'
      || compatibility.declaration.protocolVersion < CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION)) {
      next(new Error('client-update-required')); return;
    }
    next();
  });
  io.on('connection', (socket) => {
    sessions.push(socket);
    socket.on('rpc-call', async (value: { method: string; params: unknown }, ack: (value: unknown) => void) => {
      rpc.push(value);
      const content: SocketRpcContent = contentCredential
        ? { mode: 'e2ee', cipher: createSessionContentEncryption(dataKey) } : { mode: 'plain' };
      const request = await socketRpcCodec.decodeRequestParams(content, value.params, value.method);
      ack(rejectRpc ? { ok: false, error: 'permission_denied', errorCode: 'PERMISSION_DENIED' }
        : { ok: true, result: await socketRpcCodec.encodeResponse(content, { ok: true }, request.callId) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP endpoint missing');
  const client = connect({ endpoint: `http://127.0.0.1:${address.port}`, token: contentCredential ? credential : TOKEN });
  cleanup.push(async () => { await client.close(); await new Promise<void>((resolve) => io.close(() => resolve())); });
  const update = (body: unknown) => {
    for (const wake of waitingActions) wake();
    io.emit('update', { id: 'update', seq: 1, createdAt: 1, body });
  };
  return { client, sessions, rpc, actions, requests, followReads, update,
    setSharedMetadata(value: SessionSharedMetadataV1) {
      sharedMetadata = SessionSharedMetadataV1Schema.parse(value); sharedMetadataVersion++; revision++; changeHint = {};
      update({ t: 'update-session', id: 'session-1', metadata: { value: 'opaque-ciphertext', version: sharedMetadataVersion } });
    },
    requireCurrentCompatibility() { requireCompatibility = true; },
    async stream(text: string, tick: number, baseLength?: number) {
      const payload = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: text } },
        meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'segment', segmentState: 'streaming', startedAtMs: 1_000, updatedAtMs: 1_000 + tick } } };
      io.emit('ephemeral', { type: baseLength === undefined ? 'transcript-stream-segment' : 'transcript-stream-segment-delta', sessionId: 'session-1',
        message: { localId: 'segment', createdAt: 1_000, updatedAt: 1_000 + tick, tick,
          ...(baseLength === undefined ? {} : { baseLength }),
          content: contentCredential ? { t: 'encrypted', c: encodeBase64(await sealSessionDataKeyBundleV0(payload, dataKey), 'base64') }
            : { t: 'plain', v: payload } } });
    },
    setOffline(value: boolean) { offline = value; if (value) for (const wake of waitingActions) wake(); },
    setActive(value: boolean) { active = value; revision++; changeHint = {}; update({ t: 'update-session', id: 'session-1', active }); },
    setOpenedFailure() { openedFailure = true; },
    deactivateAtCursorRead() { deactivateAtInitialCursor = true; },
    inactiveEmptyReads: () => inactiveEmptyReads,
    setStoredFailure(value: 'corrupt' | 'mode_mismatch') { storedFailure = value; },
    setSparseHistory() { rows = [row(8, 'sparse canonical history')]; },
    corruptDataKey() { dataEncryptionKey = encodeBase64(new Uint8Array(81), 'base64'); },
    holdHistory() { holdHistory = true; },
    releaseHistory() { holdHistory = false; for (const send of heldHistory.splice(0)) send(); },
    append(text: string) { const entry = row(rows.length + 1, text); rows.push(entry); revision++; void wireRow(entry).then((message) => update({ t: 'new-message', sid: 'session-1', message })); },
    revise(text: string) { rows[0] = row(1, text, 100); revision++; changeHint = { updatedMessageId: 'row-1', updatedMessageSeq: 1 }; update({ t: 'message-updated', sid: 'session-1', message: rows[0] }); },
    reviseAfterUnrelatedAccountPage(text: string) { rows[0] = row(1, text, 100); unrelatedChangePage = true; revision = 201; changeHint = { updatedMessageId: 'row-1', updatedMessageSeq: 1 }; },
    removeFirst() { rows = rows.slice(1); cursorGone = true; },
    rejectPermission() { rejectRpc = true; },
    clearPending() {
      const request = state.requests?.permission;
      // The real permission store removes the outstanding request and writes
      // its terminal completion in the same authoritative Agent-state update.
      state = { requests: {}, completedRequests: request ? { permission: { ...request,
        status: 'approved', decision: 'approved', completedAt: 2 } } : {} };
      stateVersion++; revision++; changeHint = {}; void storedState(state).then((value) => update({ t: 'update-session', id: 'session-1',
      agentState: { value, version: stateVersion } })); },
  };
}

describe('SDK live Session over real HTTP and Socket.IO', () => {
  it('recovers from a failed pushed Action read even when the viewer socket stays connected', async () => {
    const server = await fixture('e2ee');
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    server.setOffline(true);
    server.append('wake the failed read');
    await expect.poll(() => controller.getSnapshot().connection).not.toBe('online');
    server.setOffline(false);
    await expect.poll(() => controller.getSnapshot().connection).toBe('online');
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2']);
  });
  it('makes no idle bearer-only E2EE requests and fetches once for a pushed change', async () => {
    const server = await fixture('e2ee');
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const requestCount = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.requests).toHaveLength(requestCount);
    const followCount = server.followReads.length;
    server.append('pushed row');
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.followReads).toHaveLength(followCount + 1);
    expect(server.sessions).toHaveLength(0);
  });
  it('keeps following pushed changes past a failed-content witness and renders later rows', async () => {
    const server = await fixture('e2ee'); server.setOpenedFailure(); server.append('valid after failure');
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2']);
    expect(durableRows(controller)[0]!.meta).toMatchObject({ happierUnsupportedContentV1: 'unparsed-agent-message' });
    server.append('still following');
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2', 'row-3']);
    expect(controller.getSnapshot().connection).toBe('online');
  });

  it('makes no changes-feed requests while idle, then refreshes state and rows on a pushed Session change', async () => {
    const server = await fixture('e2ee');
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const start = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.requests.slice(start)).toEqual([]);
    server.clearPending(); server.append('changed after idle');
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2']);
    await expect.poll(() => controller.getSnapshot().pendingRequests).toEqual([]);
  });

  it('wakes public followTranscript on pushes without idle reads', async () => {
    const server = await fixture('e2ee');
    const iterable = server.client.sessions.get('session-1').followTranscript({ cursor: '0' });
    const iterator = iterable[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe('row-1');
    const next = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const count = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.requests).toHaveLength(count);
    const follows = server.followReads.length;
    server.append('public push');
    expect((await next).value?.id).toBe('row-2');
    expect(server.followReads).toHaveLength(follows + 1);
    expect(server.sessions).toHaveLength(0);
    await iterator.return?.();
  });

  it('drains a public follower when the Session was already inactive before subscription', async () => {
    const server = await fixture('e2ee');
    server.setActive(false);
    const iterator = server.client.sessions.get('session-1').followTranscript({ cursor: '0' })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe('row-1');
    const done = iterator.next();
    await expect.poll(() => server.inactiveEmptyReads()).toBeGreaterThanOrEqual(2);
    await expect(done).resolves.toMatchObject({ done: true });
    expect(server.sessions).toHaveLength(0);
  });

  it('takes the initial change cursor before the snapshot so bootstrap cannot miss inactivity', async () => {
    const server = await fixture('e2ee'); server.deactivateAtCursorRead();
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => controller.getSnapshot().history.loading).toBe(false);
    expect(controller.getSnapshot().actions.send).toBe(false);
  });

  it('serializes encrypted stream opening so a delta cannot overtake its snapshot', async () => {
    const server = await fixture('e2ee', true);
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let release: (() => void) | undefined;
    let first = true;
    const delayed = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); }
      return decrypt(...args);
    });
    try {
      await server.stream('Hello', 1);
      await expect.poll(() => release !== undefined).toBe(true);
      await server.stream(' world', 2, 5);
      // A terminal Session state update follows both frames on the same socket.
      // Once observed, both segment events have reached the controller.
      server.setActive(false);
      await expect.poll(() => controller.getSnapshot().actions.send).toBe(false);
      release?.();
      await expect.poll(() => Object.values(controller.getSnapshot().transcript.messagesById)
        .some((message) => 'text' in message && message.text === 'Hello world')).toBe(true);
    } finally { release?.(); delayed.mockRestore(); }
  });
  it('reconciles Action confirmations from recipient-safe shared metadata only', async () => {
    const server = await fixture('e2ee');
    const request = {
      tool: 'Happier Action confirmation' as const, kind: 'user_action' as const,
      arguments: { actionId: 'session.activity.get' as const, preview: { sessionId: 'session-1' }, sessionId: 'session-1', turnId: 'turn-1' },
      createdAt: 1, turnId: 'turn-1', source: 'happier_action' as const,
      responseTarget: { kind: 'happier_action_confirmation_v1' as const, requestId: 'action:1', actionId: 'session.activity.get' as const,
        inputDigestV1: `sha256:${'0'.repeat(64)}`, runtimeAccountId: 'account-runtime', sessionId: 'session-1', turnId: 'turn-1' },
    };
    server.setSharedMetadata({ v: 1, actionConfirmationsV1: { v: 1, requests: { 'action:1': request }, completedRequests: {} } });
    const controller = await server.client.sessions.get('session-1').live();
    expect(controller.transport).toBe('action');
    await expect.poll(() => controller.getSnapshot().pendingRequests).toEqual([expect.objectContaining({
      id: 'action:1', kind: 'user_action', source: 'happier_action', responseTarget: request.responseTarget,
    })]);
    expect(controller.getSnapshot().agentState).toBeNull();
    expect(controller.getSnapshot().metadata).toMatchObject({ v: 1, actionConfirmationsV1: { requests: { 'action:1': request } } });
    await controller.respondToPermission({ id: 'action:1', turnId: 'turn-1', approved: true });
    expect(controller.getSnapshot().pendingRequests.map((pending) => pending.id)).toEqual(['action:1']);
    server.setSharedMetadata({ v: 1, actionConfirmationsV1: { v: 1, requests: {}, completedRequests: {
      'action:1': { ...request, completedAt: 2, status: 'approved', decision: 'approved' },
    } } });
    await expect.poll(() => controller.getSnapshot().pendingRequests).toEqual([]);
    expect(controller.getSnapshot().metadata).toMatchObject({ actionConfirmationsV1: { completedRequests: {
      'action:1': { status: 'approved' },
    } } });
    expect(server.sessions).toHaveLength(0);
  });

  it('declares current stored-content compatibility on snapshot HTTP and viewer socket boundaries', async () => {
    const server = await fixture();
    server.requireCurrentCompatibility();
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    expect(parseAccountStoredContentCompatibilitySocketAuthV1(server.sessions[0]?.handshake.auth))
      .toEqual({ status: 'valid', declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
  });

  it('loads history, preserves unchanged rows, and keeps pending truth until state reconciles', async () => {
    const server = await fixture();
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    expect(controller.transport).toBe('socket');
    expect(server.requests).toContain('/v2/sessions/session-1?accessProjectionVersion=1');
    expect(server.sessions[0]?.handshake.auth).toMatchObject({ clientType: 'session-scoped', sessionId: 'session-1' });
    expect(server.sessions[0]?.handshake.auth.machineId).toBeUndefined();
    const first = durableRows(controller)[0]!;
    expect(controller.getSnapshot().pendingRequests.map((request) => request.id)).toContain('permission');
    await controller.respondToPermission({ id: 'permission', approved: true });
    expect(controller.getSnapshot().pendingRequests.map((request) => request.id)).toContain('permission');
    server.rejectPermission();
    await expect(controller.respondToPermission({ id: 'permission', approved: false })).rejects.toBeInstanceOf(Error);
    expect(controller.getSnapshot().pendingRequests.map((request) => request.id)).toContain('permission');
    const publishedTranscript = controller.getSnapshot().transcript;
    const publishedMessageIds = Object.keys(publishedTranscript.messagesById);
    server.append('second');
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2']);
    expect(controller.getSnapshot().transcript.messagesById[first!.id]).toBe(first);
    expect(controller.getSnapshot().transcript.messagesById).not.toBe(publishedTranscript.messagesById);
    expect(Object.keys(publishedTranscript.messagesById)).toEqual(publishedMessageIds);
    expect(publishedTranscript.messagesById[first.id]).toBe(first);
    server.clearPending();
    await expect.poll(() => controller.getSnapshot().pendingRequests.length).toBe(0);
    await controller.close();
    expect(controller.getSnapshot().connection).toBe('closed');
  });

  it('reflects every credential operation from the real server projection', async () => {
    const server = await fixture();
    const controller = await server.client.sessions.get('session-1').live();
    expect(controller.getSnapshot().actions).toEqual({ send: true, respondToPermission: true, answerUserAction: true, abort: true });
  });

  it('preserves the published snapshot when a session notification changes no facts', async () => {
    const server = await fixture();
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    await expect.poll(() => controller.getSnapshot().connection).toBe('online');
    const before = controller.getSnapshot();
    const published: ReturnType<typeof controller.getSnapshot>[] = [];
    const unsubscribe = controller.subscribe(() => published.push(controller.getSnapshot()));
    try {
      server.update({ t: 'update-session', id: 'session-1', active: true });
      server.setActive(false);
      await expect.poll(() => controller.getSnapshot().actions.send).toBe(false);
      // The real changed event is an ordering witness after the no-op event on
      // the same socket, so this does not rely on a quiet-period test timer.
      expect(published.some((snapshot) => snapshot.actions.send === before.actions.send)).toBe(false);
      expect(published.every((snapshot) => snapshot.transcript === before.transcript)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('opens the viewer DEK with Account material and keeps E2EE socket RPC encrypted', async () => {
    const server = await fixture('e2ee', true);
    const controller = await server.client.sessions.get('session-1').live();
    expect(controller.transport).toBe('socket');
    await expect.poll(() => Object.values(controller.getSnapshot().transcript.messagesById).some((message) => 'text' in message && message.text === 'first')).toBe(true);
    expect(controller.getSnapshot().pendingRequests.map((request) => request.id)).toContain('permission');
    await controller.respondToPermission({ id: 'permission', approved: true });
    expect(server.rpc.at(-1)).toMatchObject({ params: expect.any(String), method: `session-1:${RPC_METHODS.SESSION_PERMISSION_RESPOND}` });
    await controller.close();
  });

  it('fails closed on unavailable socket content instead of falling back to Action reads', async () => {
    const bearer = await fixture('e2ee');
    await expect(bearer.client.sessions.get('session-1').live({ transport: 'socket' })).rejects.toMatchObject({ code: 'session_content_locked' });
    expect(bearer.requests.some((path) => path.includes('transcript.follow'))).toBe(false);
    const encrypted = await fixture('e2ee', true);
    encrypted.corruptDataKey();
    await expect(encrypted.client.sessions.get('session-1').live()).rejects.toMatchObject({ code: 'session_content_locked' });
    expect(encrypted.requests.some((path) => path.includes('transcript.follow'))).toBe(false);
  });

  it('preserves a rich Action permission response rather than changing abort to deny', async () => {
    const server = await fixture('e2ee');
    const controller = await server.client.sessions.get('session-1').live();
    await expect(controller.respondToPermission({ id: 'permission', approved: false, decision: 'abort', mode: 'plan', reason: 'cancel the requested operation' })).resolves.toBeUndefined();
    expect(server.actions.filter((action) => action.actionId === 'session.permission.respond').at(-1)?.input).toMatchObject({
      requestId: 'permission', approved: false, decision: 'abort', mode: 'plan', reason: 'cancel the requested operation',
    });
  });

  it('closes only its own viewer and root close rejects a pending history result', async () => {
    const server = await fixture();
    const first = await server.client.sessions.get('session-1').live();
    const second = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(second)).toEqual(['row-1']);
    await first.close();
    server.append('sibling remains live');
    await expect.poll(() => durableIds(second)).toEqual(['row-1', 'row-2']);
    expect(first.getSnapshot().connection).toBe('closed');
    expect(durableIds(first)).toEqual(['row-1']);
    await second.close();
    server.holdHistory();
    const pending = await server.client.sessions.get('session-1').live();
    expect(pending.getSnapshot().history.loading).toBe(true);
    await server.client.close();
    server.releaseHistory();
    expect(pending.getSnapshot().connection).toBe('closed');
    expect(durableIds(pending)).toEqual([]);
  });

  it('assembles the same live delta independently for sibling controllers', async () => {
    const server = await fixture();
    const first = await server.client.sessions.get('session-1').live();
    const second = await server.client.sessions.get('session-1').live();
    const hasText = (controller: typeof first, text: string) => Object.values(controller.getSnapshot().transcript.messagesById)
      .some((message) => 'text' in message && message.text === text);
    server.stream('Hello', 1);
    await expect.poll(() => hasText(first, 'Hello') && hasText(second, 'Hello')).toBe(true);
    const beforeDelta = first.getSnapshot().transcript;
    const segmentId = beforeDelta.messageIdsOldestFirst.find((id) => {
      const message = beforeDelta.messagesById[id];
      return message && 'text' in message && message.text === 'Hello';
    });
    if (!segmentId) throw new Error('Stream snapshot did not materialize');
    server.stream(' world', 2, 5);
    await expect.poll(() => hasText(first, 'Hello world') && hasText(second, 'Hello world')).toBe(true);
    expect(first.getSnapshot().transcript.messagesById).not.toBe(beforeDelta.messagesById);
    expect(beforeDelta.messagesById[segmentId]).toMatchObject({ text: 'Hello' });
  });

  it('selects bearer-only E2EE Action reads once and repairs revisions after a real HTTP outage', async () => {
    const server = await fixture('e2ee');
    const controller = await server.client.sessions.get('session-1').live();
    expect(controller.transport).toBe('action');
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    expect(server.sessions).toHaveLength(0);
    expect(controller.getSnapshot().pendingRequests.map((request) => request.id)).toContain('permission');
    await controller.respondToPermission({ id: 'permission', approved: true });
    expect(controller.getSnapshot().pendingRequests.map((request) => request.id)).toContain('permission');
    server.setOffline(true);
    await expect.poll(() => controller.getSnapshot().connection).not.toBe('online');
    server.revise('repaired over Action reads'); server.append('new Action row'); server.setOffline(false);
    await expect.poll(() => Object.values(controller.getSnapshot().transcript.messagesById).some((message) => 'text' in message && message.text === 'repaired over Action reads'), { timeout: 10_000 }).toBe(true);
    try {
      await expect.poll(() => durableIds(controller), { timeout: 10_000 }).toEqual(['row-1', 'row-2']);
    } catch (error) {
      throw new Error(`Polling recovery boundary: ${JSON.stringify({
        connection: controller.getSnapshot().connection, durableIds: durableIds(controller),
        follows: server.followReads, releases: server.actions.filter((action) => action.actionId === 'transcript.unfollow')
          .map((action) => action.input.leaseId), requests: server.requests.slice(-20),
      })}`, { cause: error });
    }
    server.clearPending();
    await expect.poll(() => controller.getSnapshot().pendingRequests.length).toBe(0);
    expect(controller.getSnapshot().actions.abort).toBe(false);
    await controller.close();
  }, 20_000);

  it('repairs a pushed same-sequence revision through Actions without a viewer or changes feed', async () => {
    const server = await fixture('e2ee');
    const controller = await server.client.sessions.get('session-1').live({ transport: 'action' });
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    server.revise('revised through the waiting Action');
    await expect.poll(() => durableRows(controller).some((message) => 'text' in message
      && message.text === 'revised through the waiting Action')).toBe(true);
    expect(server.sessions).toHaveLength(0);
    expect(server.requests.some((path) => path.startsWith('/v2/changes') || path.startsWith('/v2/cursor'))).toBe(false);
  });

  it('keeps push observation alive across inactivity and external reactivation without idle reads', async () => {
    const server = await fixture('e2ee');
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    server.setActive(false);
    await expect.poll(() => controller.getSnapshot().actions.send).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const requestCount = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.requests).toHaveLength(requestCount);
    server.setActive(true); server.append('external reactivation');
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2']);
    await expect.poll(() => controller.getSnapshot().actions.send).toBe(true);
  });

  it('does not invent older rows when full authoritative history starts at a sparse sequence', async () => {
    const server = await fixture(); server.setSparseHistory();
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => controller.getSnapshot().history.loading).toBe(false);
    expect(durableIds(controller)).toEqual(['row-8']);
    expect(controller.getSnapshot().history.hasMoreOlder).toBe(false);
    await expect(controller.loadOlder()).resolves.toEqual({ hasMore: false });
  });

  it('establishes older availability from page evidence for an explicit history boundary', async () => {
    const server = await fixture();
    const controller = await server.client.sessions.get('session-1').live({ history: { afterSeq: 1 } });
    await expect.poll(() => controller.getSnapshot().history.loading).toBe(false);
    expect(controller.getSnapshot().history.hasMoreOlder).toBe(true);
    await expect(controller.loadOlder()).resolves.toEqual({ hasMore: false });
    expect(durableIds(controller)).toEqual(['row-1']);
    const sparse = await fixture(); sparse.setSparseHistory();
    const noOlder = await sparse.client.sessions.get('session-1').live({ history: { afterSeq: 7 } });
    await expect.poll(() => noOlder.getSnapshot().history.loading).toBe(false);
    expect(noOlder.getSnapshot().history.hasMoreOlder).toBe(false);
  });

  it.each(['corrupt', 'mode_mismatch'] as const)('keeps a visible canonical unsupported row for %s stored content', async (status) => {
    const server = await fixture('e2ee', true); server.setStoredFailure(status);
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => controller.getSnapshot().history.loading).toBe(false);
    expect(durableIds(controller)).toEqual(['row-1']);
    expect(durableRows(controller)[0]!.meta).toMatchObject({ happierUnsupportedContentV1: 'unparsed-agent-message' });
  });

  it('repairs a disconnected revision and resets history on cursor-gone', async () => {
    const server = await fixture();
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => controller.getSnapshot().connection).toBe('online');
    server.sessions[0]!.conn.close();
    server.revise('revised');
    server.append('while disconnected');
    await expect.poll(() => Object.values(controller.getSnapshot().transcript.messagesById).some((message) => 'text' in message && message.text === 'revised'), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => durableIds(controller)).toEqual(['row-1', 'row-2']);
    server.sessions.at(-1)!.conn.close();
    server.removeFirst();
    await expect.poll(() => durableIds(controller), { timeout: 10_000 }).toEqual(['row-2']);
    await server.client.close();
    expect(controller.getSnapshot().connection).toBe('closed');
    await expect(controller.send('late')).rejects.toMatchObject({ name: 'HappierClientClosedError' });
  }, 20_000);

  it('repairs a disconnected revision beyond an empty Session-filtered Account changes page', async () => {
    const server = await fixture();
    const controller = await server.client.sessions.get('session-1').live();
    await expect.poll(() => durableIds(controller)).toEqual(['row-1']);
    server.sessions[0]!.conn.close();
    server.reviseAfterUnrelatedAccountPage('revised beyond unrelated activity');
    await expect.poll(() => durableRows(controller).some((message) => 'text' in message
      && message.text === 'revised beyond unrelated activity'), { timeout: 10_000 }).toBe(true);
    expect(durableIds(controller)).toEqual(['row-1']);
    expect(controller.getSnapshot().connection).toBe('online');
  }, 20_000);
});
