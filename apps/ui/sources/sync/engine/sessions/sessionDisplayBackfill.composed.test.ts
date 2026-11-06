import { afterEach, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { openSessionOwnerDisplayEnvelopeV1, openSessionSharedDisplayEnvelopeV1, sealSessionSharedDisplayEnvelopeV1, sealSessionOwnerDisplayEnvelopeV1,
    projectSessionDisplayV1, projectLegacySessionAccessCapabilitiesV1, SessionSharedMetadataV1Schema } from '@happier-dev/protocol';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
const { readSessionSnapshotsForAuthority, ensureSessionDisplayProjectionsForRead } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
const { serverFetch } = await import('@/sync/http/client');
const { loadSyncTuning } = await import('@/sync/runtime/syncTuning');
const initialState = storage.getState();
let homes: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { await homes?.dispose(); homes = undefined; storage.setState(initialState, true); });

it.each(['default', 'read-only'] as const)('retains full Session content with %s tuple-maintenance demand', async demand => {
    const id = `full-${demand}`;
    const persisted = createSessionMetadataHttpBoundary(() => ({}));
    persisted.replaceSession(id, SessionCurrentProjectionRecordV1Schema.parse({ ...createPlainSessionCurrentProjectionRecordFixture({
        id, metadataVersion: 7, agentStateVersion: 4,
        metadata: { name: 'Private full Session', path: '/full/private', host: 'owner-host' },
    }), agentState: JSON.stringify({ requests: {}, completedRequests: {} }) }));
    const transport = createSessionReadBatchHttpBoundary(request => persisted.handle(request.url, {
        method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    }) ?? undefined);
    homes = await serveAccountHomes({ homes: [{ key: 'owner', serverUrl: `https://display-${demand}.test`,
        accountId: `display-${demand}`, currentAccount: true }], route: request => transport.handle(request) });
    const result = await runWithServerRequestAuthorityForServerAccountScope({ serverId: homes.homes.owner!.id, activeRequest: serverFetch },
        authority => readSessionSnapshotsForAuthority({ authority, sessionIds: [id], includeTurns: false,
            awaitDisplayProjectionMaintenance: true,
            ...(demand === 'read-only' ? { includeMetadataTupleMutationSnapshot: false as const } : {}),
        }));
    const opened = result.get(id);
    expect(opened).toMatchObject({ ok: true, snapshot: { session: {
        ownerMetadataView: { name: 'Private full Session', path: '/full/private', host: 'owner-host' },
        agentState: { requests: {}, completedRequests: {} },
    } } });
    if (!opened?.ok) throw new Error('Expected admitted full Session');
    expect(opened.snapshot.displayProjectionMaintenance).toBe(demand === 'read-only' ? undefined : 'satisfied');
    expect(persisted.writes).toEqual(demand === 'read-only' ? [] : [id]);
    expect(homes.requests.filter(request => request.path === `/v2/sessions/${id}` && request.method === 'PATCH'))
        .toHaveLength(demand === 'read-only' ? 0 : 1);
    expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(1);
    expect(homes.requests.filter(request => request.path === `/v2/sessions/${id}` && request.method === 'GET')).toHaveLength(0);
});

it('returns the readable full Session before a held maintenance PATCH and completes maintenance after the reader releases its authority', async () => {
    const id = 'retained-first-open';
    const persisted = createSessionMetadataHttpBoundary(() => ({}));
    persisted.replaceSession(id, SessionCurrentProjectionRecordV1Schema.parse(createPlainSessionCurrentProjectionRecordFixture({
        id, metadataVersion: 7, metadata: { name: 'Retained title', path: '/retained', host: 'host' },
    })));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let patchStarted = false;
    const transport = createSessionReadBatchHttpBoundary(async request => {
        if (request.method === 'PATCH') { patchStarted = true; await held; }
        return persisted.handle(request.url, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'owner', serverUrl: 'https://display-first-open.test',
        accountId: 'display-first-open', currentAccount: true }], route: request => transport.handle(request) });
    let returned = false;
    const read = runWithServerRequestAuthorityForServerAccountScope({ serverId: homes.homes.owner!.id, activeRequest: serverFetch },
        authority => readSessionSnapshotsForAuthority({ authority, sessionIds: [id], includeTurns: false }))
        .then(result => { returned = true; return result; });
    try {
        await vi.waitFor(() => expect(patchStarted).toBe(true));
        await vi.waitFor(() => expect(returned).toBe(true));
        expect((await read).get(id)).toMatchObject({ ok: true, snapshot: { session: { ownerMetadataView: { name: 'Retained title' } } } });
        expect(persisted.writes).toEqual([]);
    } finally {
        release();
        await read;
        await vi.waitFor(() => expect(persisted.writes).toContain(id));
    }
});

it.each(['success', 'refused', 'unopenable-owner', 'read-only-principal'] as const)('backfills only through the captured full tuple and retains readable data after %s', async disposition => {
    const id = 'retained-owner-without-display';
    let source = SessionCurrentProjectionRecordV1Schema.parse({ ...createPlainSessionCurrentProjectionRecordFixture({ id,
        metadataVersion: 7, metadata: { name: 'Retained private title', path: '/retained/private', host: 'retained-host' } }),
        agentState: JSON.stringify({ requests: {}, completedRequests: {} }), agentStateVersion: 4 });
    if (disposition === 'unopenable-owner') {
        const projected = projectSessionDisplayV1({ sharedMetadata: SessionSharedMetadataV1Schema.parse(JSON.parse(source.metadata)) });
        const shared = await sealSessionSharedDisplayEnvelopeV1({ sessionMode: 'plain', display: projected.shared });
        if (!shared.ok) throw new Error('Expected actual shared display leaf');
        const owner = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee',
            material: { type: 'legacy', secret: new Uint8Array(32).fill(19) },
            display: { v: 1, name: 'Old encrypted owner title' }, randomBytes: getRandomBytes });
        if (!owner.ok) throw new Error('Expected actual old owner display leaf');
        source = SessionCurrentProjectionRecordV1Schema.parse({ ...source, displayProjectionV1: {
            v: 1, sourceMetadataVersion: source.metadataVersion, metadataLayoutVersion: 1,
            shared: shared.envelope, owner: owner.envelope,
        } });
    }
    const persisted = createSessionMetadataHttpBoundary(() => ({}));
    persisted.replaceSession(id, source);
    const transport = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${id}`
        && request.method === 'PATCH' && disposition === 'refused'
        ? Response.json({ error: 'Forbidden' }, { status: 403 })
        : persisted.handle(request.url, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined);
    const terminalToken = `header.${Buffer.from(JSON.stringify({ sub: 'display-backfill-owner',
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' }, tokenEpoch: 0 })).toString('base64url')}.signature`;
    homes = await serveAccountHomes({ homes: [{ key: 'owner', serverUrl: 'https://display-backfill-owner.test',
        accountId: 'display-backfill-owner', currentAccount: true,
        ...(disposition === 'read-only-principal' ? { credentials: { token: terminalToken } } : {}) }],
        route: request => transport.handle(request) });
    const home = homes.homes.owner!;
    const result = await runWithServerRequestAuthorityForServerAccountScope({ serverId: home.id, activeRequest: serverFetch }, authority =>
        readSessionSnapshotsForAuthority({ authority, sessionIds: [id], includeTurns: false, awaitDisplayProjectionMaintenance: true }));
    expect(result.get(id)).toMatchObject({ ok: true, snapshot: { session: { ownerMetadataView: {
        name: 'Retained private title', path: '/retained/private' } } } });
    expect(storage.getState().sessions[id]).toBeUndefined();
    const opened = result.get(id);
    if (!opened?.ok) throw new Error('Expected readable full snapshot');
    expect(opened.snapshot.displayProjectionMaintenance).toBe(disposition === 'read-only-principal' ? undefined
        : disposition === 'refused' ? 'deferred' : 'satisfied');
    expect(homes.requests.filter(request => request.path === `/v2/sessions/${id}` && request.method === 'PATCH'))
        .toHaveLength(disposition === 'read-only-principal' ? 0 : 1);
    const response = persisted.handle(new URL(`/v2/sessions/${id}`, home.serverUrl));
    if (!response) throw new Error('Expected persisted owner tuple');
    const committed = SessionCurrentProjectionRecordV1Schema.parse((await response.json()).session);
    expect(committed.metadata).toBe(source.metadata);
    expect(committed.ownerMetadata).toEqual(source.ownerMetadata);
    expect(committed.agentState).toBe(source.agentState);
    expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(1);
    expect(homes.requests.filter(request => request.path === `/v2/sessions/${id}` && request.method === 'GET')).toHaveLength(0);
    if (disposition === 'refused' || disposition === 'read-only-principal') {
        expect(committed).toEqual(source);
        return;
    }
    expect(persisted.writes).toEqual([id]);
    if (disposition === 'unopenable-owner') {
        expect(committed.displayProjectionV1?.shared).toEqual(source.displayProjectionV1?.shared);
    }
    expect(committed.displayProjectionV1).toMatchObject({ sourceMetadataVersion: committed.metadataVersion, metadataLayoutVersion: 1 });
    await expect(openSessionSharedDisplayEnvelopeV1({ sessionMode: 'plain', envelope: committed.displayProjectionV1?.shared }))
        .resolves.toMatchObject({ ok: true });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', envelope: committed.displayProjectionV1?.owner }))
        .toMatchObject({ ok: true, display: { name: 'Retained private title', path: '/retained/private' } });
    const repeated = await runWithServerRequestAuthorityForServerAccountScope({ serverId: home.id, activeRequest: serverFetch }, authority =>
        readSessionSnapshotsForAuthority({ authority, sessionIds: [id], includeTurns: false, awaitDisplayProjectionMaintenance: true }));
    expect(repeated.get(id)?.ok).toBe(true);
    expect(persisted.writes).toEqual([id]);
    expect(homes.requests.filter(request => request.path === `/v2/sessions/${id}` && request.method === 'PATCH')).toHaveLength(1);
});

it.each(['recipient', 'owner-refused'] as const)('keeps actual %s full-read owner display maintenance distinct', async disposition => {
    const id = 'shared-recipient-without-owner-display';
    const ownerRecord = createPlainSessionCurrentProjectionRecordFixture({ id,
        metadataVersion: 7, agentStateVersion: 4,
        metadata: { path: '/private/not-shared', host: 'owner-host', summary: { text: 'Shared summary', updatedAt: 1 } } });
    const { ownerMetadata: _ownerMetadata, ...record } = ownerRecord;
    const source = disposition === 'owner-refused' ? ownerRecord : SessionCurrentProjectionRecordV1Schema.parse({ ...record,
        share: { accessLevel: 'edit', canApprovePermissions: false },
        effectiveAccess: { v: 1, level: 'edit',
            sources: [{ kind: 'team', teamId: 'shared-team', requiredByTeamPolicy: false }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'edit' }) } });
    const persisted = createSessionMetadataHttpBoundary(() => ({}));
    persisted.replaceSession(id, source);
    const transport = createSessionReadBatchHttpBoundary(request => {
        if (disposition === 'owner-refused' && request.method === 'PATCH' && request.path === `/v2/sessions/${id}`) {
            return Response.json({ error: 'Forbidden' }, { status: 403 });
        }
        return persisted.handle(request.url, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'recipient', serverUrl: 'https://display-backfill-recipient.test',
        accountId: 'display-backfill-recipient', currentAccount: true }], route: request => transport.handle(request) });
    const home = homes.homes.recipient!;
    await runWithServerRequestAuthorityForServerAccountScope({ serverId: home.id, activeRequest: serverFetch }, async authority => {
        const full = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [id], includeTurns: false, awaitDisplayProjectionMaintenance: true })).get(id);
        expect(full).toMatchObject(disposition === 'recipient' ? { ok: true, snapshot: { session: {
            access: { level: 'edit' }, ownerMetadataView: null, metadata: { summary: { text: 'Shared summary' } },
        } } } : { ok: true, snapshot: { displayProjectionMaintenance: 'deferred', session: {
            access: { level: 'owner' }, ownerMetadataView: { path: '/private/not-shared' },
        } } });
        const credentials = authority.context.credentials;
        if (!credentials) throw new Error('Expected the captured recipient Account credentials');
        expect(await ensureSessionDisplayProjectionsForRead({ serverId: home.id, credentials,
            request: authority.request, sessionIds: [id], isCurrent: () => true })).toBe(disposition === 'recipient');
    });
    expect(persisted.writes).toEqual([]);
    expect(storage.getState().sessions[id]).toBeUndefined();
});

it.each(['complete', 'cancel'] as const)('keeps declared maintenance PATCH work within the existing resume concurrency budget on %s', async disposition => {
    const limit = loadSyncTuning().resumeConcurrencyLimit;
    const ids = Array.from({ length: limit + 1 }, (_, index) => `budgeted-owner-${index}`);
    const persisted = createSessionMetadataHttpBoundary(() => ({}));
    for (const id of ids) persisted.replaceSession(id, SessionCurrentProjectionRecordV1Schema.parse(
        createPlainSessionCurrentProjectionRecordFixture({ id, metadataVersion: 7,
            metadata: { name: id, path: '/retained/private', host: 'retained-host' } })));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let active = 0;
    let maximum = 0;
    const controller = new AbortController();
    const transport = createSessionReadBatchHttpBoundary(async request => {
        if (request.method === 'PATCH') {
            active++;
            maximum = Math.max(maximum, active);
            try { await held; }
            finally { active--; }
        }
        return persisted.handle(request.url, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'owner', serverUrl: 'https://display-backfill-budget.test',
        accountId: 'display-backfill-budget', currentAccount: true }], route: request => transport.handle(request) });
    const read = runWithServerRequestAuthorityForServerAccountScope({ serverId: homes.homes.owner!.id, activeRequest: serverFetch },
        authority => readSessionSnapshotsForAuthority({ authority, sessionIds: ids, includeTurns: false,
            awaitDisplayProjectionMaintenance: true,
            processingConcurrencyLimit: limit, signal: controller.signal }));
    try {
        await vi.waitFor(() => expect(active).toBeGreaterThanOrEqual(limit));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(maximum).toBeLessThanOrEqual(limit);
        if (disposition === 'cancel') controller.abort(new Error('maintenance caller cancelled'));
    } finally {
        release();
        if (controller.signal.aborted) await expect(read).rejects.toThrow('maintenance caller cancelled');
        else {
            const results = await read;
            expect([...results.values()].every(result => result.ok)).toBe(true);
        }
    }
    expect(persisted.writes).toHaveLength(disposition === 'cancel' ? limit : ids.length);
});
