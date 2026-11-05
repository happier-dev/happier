import { cpus, platform, arch } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import * as ownerEnvelopes from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import * as dataKeyEnvelopes from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import * as metadataSchemas from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectLegacySessionAccessCapabilitiesV1,
    SessionListQueryResponseV1Schema,
    type V2SessionRecord,
    V2SessionRecordSchema,
    type SessionListQueryV1,
} from '@happier-dev/protocol';

import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';
import { resolveVisibleSessionListIndexSummary } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { storage } from '@/sync/domains/state/storage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { buildSessionListCacheEntriesFromRenderables } from '@/sync/domains/state/warmCacheAdapters';
import { SessionListCacheEntryV1Schema, type SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { act, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { useSessionDisplayTitles, readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionDisplayNameProjections } from '@/sync/store/hooks';
import { readComposerSessionSuggestionDisplay } from '@/sync/domains/input/suggestionSession';
import { t } from '@/text';

import { buildRenderableFromRowAndCache, fetchAndApplySessions as fetchAndApplySessionsSource } from './sessionSnapshot';
import { createCompactSessionListFetchBoundary, createCompactSessionListRowFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { fetchAndApplySessionById } from './sessionById';
import { buildUpdatedSessionFromSocketUpdate } from './syncSessions';

function fetchAndApplySessions(params: Parameters<typeof fetchAndApplySessionsSource>[0]) {
    const request = params.request;
    return fetchAndApplySessionsSource({ ...params,
        ...(request ? { request: createCompactSessionListFetchBoundary(async (path, init) => path === '/v2/sessions/read-batch'
            ? undefined : request(path, init)) } : {}),
    });
}
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { SESSION_OWNER_METADATA_PROJECTION } from '@/sync/domains/session/readSessionOwnerMetadataView';

const QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: true, scope: 'my_work',
    attention: 'any', audiences: [], tagIds: [],
};
const initialState = storage.getState();

it('retains admitted plain owner continuation facts independently of public list identity', async () => {
    const serverId = 'admitted-continuation-home';
    const credentials = { token: 'admitted-continuation' };
    const accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
    const body = createOwnerChoicesPage();
    body.sessions = body.sessions.slice(0, 1).map(row => ({ ...row,
        metadata: JSON.stringify({ v: 1, agentPresentation: { agentId: 'codex' } }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1,
            workspace: { path: '/private/continuation', machineId: 'machine-private', flavor: 'claude' },
            nativeSession: { claudeSessionId: 'native-private', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
                nativeResumeIdentityV1: { v: 1, vendorResumeId: 'native-private' } },
            runtime: { modelOverrideV1: { v: 1, modelId: 'private-model', updatedAt: 1 } },
        }),
    }));
    const refresh = () => fetchAndApplySessions({ serverId, credentials, encryption: null, sessionDataKeys: new Map(),
        accountCurrentness,
        request: async () => Response.json(body), getExistingSession: () => null,
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions() {}, awaitSessionListHydration: true, log: { log() {} },
    });
    await refresh();
    const row = storage.getState().sessionListRowsByServerId[serverId]!['choice-0']!;
    expect(row.metadata?.flavor).toBe('codex');
    expect(storage.getState().sessions[row.id]).toBeUndefined();
    const admission = { credentials, accountMode: 'plain' as const, accountCurrentness, isCurrent: () => true };
    expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: admission })).toMatchObject({
        flavor: 'claude', claudeSessionId: 'native-private', machineId: 'machine-private',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
        nativeResumeIdentityV1: { v: 1, vendorResumeId: 'native-private' },
        modelOverrideV1: { v: 1, modelId: 'private-model', updatedAt: 1 },
    });
    expect(row[SESSION_OWNER_METADATA_PROJECTION]?.ownerMetadataEnvelope.t).toBe('plain');
    expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: { ...admission,
        accountCurrentness: { ...accountCurrentness, updatedAt: accountCurrentness.updatedAt + 1 },
    } })).toBeNull();
    expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: { ...admission,
        accountCurrentness: { ...accountCurrentness, version: accountCurrentness.version + 1 },
    } })).not.toBeNull();
    for (const withdrawn of [
        { ...row, metadataVersion: row.metadataVersion + 1 },
        { ...row, encryptedContentAvailability: 'encrypted_content_unavailable' as const },
        { ...row, access: null },
        { ...row, metadataUnavailable: true },
        { ...row, [SESSION_OWNER_METADATA_PROJECTION]: null },
    ]) expect(readSessionListRenderableOwnerMetadataView(withdrawn, { requireAdmitted: admission })).toBeNull();
    expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: { ...admission, isCurrent: () => false } })).toBeNull();
    expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: { ...admission, accountMode: 'e2ee' } })).toBeNull();
    expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: { ...admission, credentials: { token: 'other-account' } } })).toBeNull();
    expect(JSON.stringify(row)).not.toContain('native-private');
    expect(JSON.stringify(buildSessionListCacheEntriesFromRenderables({ [row.id]: row }))).not.toContain('native-private');
    await refresh();
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[row.id]).toBe(row);
});

it('hydrates full Sessions only on demand while reusing current display documents', async () => {
    const secret = new Uint8Array(32).fill(31);
    const encryption = await Encryption.create(secret);
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const rows = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
        const key = new Uint8Array(32).fill(index + 41);
        const cipher = await encryption.openEncryption(key);
        const [metadata] = await cipher.encrypt([{ path: `/hydration/${index}`, host: 'home', summary: { text: `Session ${index}`, updatedAt: 1 } }]);
        return { id: `demand-${index}`, seq: 1, createdAt: 1, updatedAt: 1, active: index === 3, activeAt: 1,
            archivedAt: null, encryptionMode: 'e2ee', metadata: encodeBase64(metadata!), metadataVersion: 1,
            agentState: null, agentStateVersion: 0, share: null,
            ...(index === 5 ? { manager: { sessionId: 'demand-2' } } : {}),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)) };
    }));
    const serverId = 'hydration-demand-home';
    const sessionDataKeys = new Map<string, Uint8Array>();
    const sessionDataKeyEnvelopes = new Map<string, string>();
    const readRows = () => storage.getState().sessionListRowsByServerId[serverId] ?? {};
    const open = vi.spyOn(dataKeyEnvelopes, 'openEncryptedDataKeyEnvelopeV1');
    const refresh = (demand?: string) => fetchAndApplySessions({
        serverId, credentials: { token: 'demand', secret: encodeBase64(secret) }, encryption, sessionDataKeys, sessionDataKeyEnvelopes,
        request: async () => Response.json({ sessions: rows, nextCursor: null, hasNext: false }),
        getExistingSession: id => storage.getState().sessions[id], getCurrentSessionListRenderable: id => readRows()[id],
        cachedSessionListEntries: buildSessionListCacheEntriesFromRenderables(readRows()),
        applySessionListRenderables: values => storage.getState().applyServerScopedSessionListRows(serverId, values, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: values => storage.getState().applySessions(values),
        priorityHydrationSessionIds: ['demand-1'], activeSessionIds: ['demand-2', ...(demand ? [demand] : [])],
        sessionListBackgroundHydrationMaxRows: 0,
        log: { log() {} },
    });
    vi.useFakeTimers();
    await refresh();
    await vi.runAllTimersAsync();
    expect([...sessionDataKeys.keys()].sort()).toEqual(rows.map(row => row.id));
    expect(open).toHaveBeenCalledTimes(6);
    await vi.waitFor(() => expect(Object.keys(storage.getState().sessions).filter(id => id.startsWith('demand-')).sort()).toEqual(['demand-1', 'demand-2']));
    const retainedRows = readRows();
    const rowPublications: Array<Readonly<{ changedIds: string[]; fields: string[] }>> = [];
    const unsubscribe = storage.subscribe((next, previous) => {
        const previousRows = previous.sessionListRowsByServerId[serverId] ?? {};
        const nextRows = next.sessionListRowsByServerId[serverId] ?? {};
        if (previousRows === nextRows) return;
        const changedIds = Object.keys(nextRows).filter(id => previousRows[id] !== nextRows[id]);
        rowPublications.push({ changedIds, fields: [...new Set(changedIds.flatMap(id =>
            [...new Set([...Reflect.ownKeys(previousRows[id] ?? {}), ...Reflect.ownKeys(nextRows[id]!)])]
                .filter(field => typeof field === 'symbol'
                    ? Reflect.get(previousRows[id] ?? {}, field) !== Reflect.get(nextRows[id]!, field)
                    : JSON.stringify(Reflect.get(previousRows[id] ?? {}, field)) !== JSON.stringify(Reflect.get(nextRows[id]!, field)))
                .map(String)))] });
    });
    try {
        await refresh();
        await vi.runAllTimersAsync();
        expect(rowPublications).toEqual([]);
        expect(readRows()).toBe(retainedRows);
    } finally { unsubscribe(); }
    expect(open).toHaveBeenCalledTimes(6);
    expect(storage.getState().sessions['demand-4']).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await refresh('demand-4');
    await vi.runAllTimersAsync();
    expect(open).toHaveBeenCalledTimes(6);
    // AES completes at the platform boundary, independently of fake timer drains.
    await vi.waitFor(() => expect(storage.getState().sessions['demand-4']?.metadata?.summary?.text).toBe('Session 4'));
    expect(storage.getState().sessions['demand-5']).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const replacementKey = new Uint8Array(32).fill(81);
    const replacementCipher = await encryption.openEncryption(replacementKey);
    const [replacementMetadata] = await replacementCipher.encrypt([{ path: '/hydration/4', host: 'home',
        summary: { text: 'Updated Session 4', updatedAt: 2 } }]);
    rows[4] = { ...rows[4]!, metadata: encodeBase64(replacementMetadata!), metadataVersion: 2,
        dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(replacementKey)) };
    await refresh();
    await vi.runAllTimersAsync();
    // The changed display opens its replacement key, without publishing a full Session.
    expect(open).toHaveBeenCalledTimes(7);
    expect(readRows()['demand-4']?.metadata?.summaryText).toBe('Updated Session 4');
    expect(storage.getState().sessions['demand-4']?.metadata?.summary?.text).toBe('Session 4');
    await refresh('demand-4');
    await vi.runAllTimersAsync();
    expect(open).toHaveBeenCalledTimes(7);
    await vi.waitFor(() => expect(storage.getState().sessions['demand-4']?.metadata?.summary?.text).toBe('Updated Session 4'));
});

it.each(['metadata', 'agent-state'] as const)('reuses a newer admitted %s document when an identical inventory descriptor lags behind', async document => {
    storage.setState(storage.getInitialState(), true);
    const serverId = 'lagging-inventory-home';
    const credentials = { token: 'lagging-inventory-account' };
    const accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
    const base = { ...createOwnerChoicesPage(1).sessions[0]!, metadataLayoutVersion: 0, ownerMetadata: undefined,
        metadata: JSON.stringify({ path: '/lagging-inventory', host: 'home', summary: { text: 'Original', updatedAt: 1 } }),
        agentStateVersion: 1, agentState: JSON.stringify({ requests: {} }),
        pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: 1 };
    const rowAt = (version: number) => ({ ...base,
        ...(document === 'metadata'
            ? { metadataVersion: version, metadata: JSON.stringify({ path: '/lagging-inventory', host: 'home',
                summary: { text: `Opened ${version}`, updatedAt: version } }) }
            : { agentStateVersion: version, agentState: JSON.stringify({ requests: {
                [`permission-${version}`]: { tool: 'Bash', kind: 'permission', arguments: { command: 'git status' }, createdAt: version },
            } }) }),
    });
    let inventory = rowAt(1);
    let detail = rowAt(2);
    const batches: string[][] = [];
    const boundary = createCompactSessionListFetchBoundary(async (path, init) => {
        if (path === '/v2/sessions/read-batch') {
            const request = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init.body)));
            batches.push(request.sessionIds);
            return Response.json({ results: request.sessionIds.map(sessionId => ({ sessionId,
                detail: { status: 200, body: { session: detail } } })) });
        }
        return Response.json({ sessions: [inventory], nextCursor: null, hasNext: false });
    });
    const currentRow = () => storage.getState().sessionListRowsByServerId[serverId]?.[base.id];
    const refresh = () => fetchAndApplySessionsSource({ serverId, credentials, accountCurrentness, encryption: null,
        contentDemand: 'list-projection', sessionDataKeys: new Map(), request: boundary,
        getExistingSession: id => storage.getState().sessions[id], getCurrentSessionListRenderable: currentRow,
        applySessionListRenderables: values => storage.getState().applyServerScopedSessionListRows(serverId, values, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: values => storage.getState().applySessions(values), awaitSessionListHydration: true, log: { log() {} },
    });
    await refresh();
    expect(batches).toEqual([[base.id]]);
    expect(currentRow()?.[document === 'metadata' ? 'metadataVersion' : 'agentStateVersion']).toBe(2);
    const retained = currentRow();
    batches.length = 0;
    for (let refreshIndex = 0; refreshIndex < 3; refreshIndex++) {
        await refresh();
        expect(currentRow()).toBe(retained);
    }
    expect(batches).toEqual([]);
    inventory = rowAt(3);
    detail = rowAt(3);
    await refresh();
    expect(batches).toEqual([[base.id]]);
    if (document === 'metadata') expect(currentRow()?.metadata?.summaryText).toBe('Opened 3');
    else expect(currentRow()?.currentRequestRef).toMatchObject({ kind: 'permission', requestId: 'permission-3' });
    const settled = currentRow();
    batches.length = 0;
    for (let refreshIndex = 0; refreshIndex < 3; refreshIndex++) {
        await refresh();
        expect(currentRow()).toBe(settled);
    }
    expect(batches).toEqual([]);
});

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    storage.setState(initialState, true);
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
});

function createOwnerChoicesPage(count = 6) {
    const rows = Array.from({ length: count }, (_, index) => ({
        id: `choice-${index}`, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        archivedAt: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1, summary: { text: `Session ${index}`, updatedAt: 1 } }),
        metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: `/private/${index}`, host: 'home' } }),
        share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
        viewer: { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'preference' } },
        responsibleAccountId: null, responsibleAccount: null,
    }));
    return { sessions: rows.map(row => V2SessionRecordSchema.parse(row)), nextCursor: null, hasNext: false,
        attentionNextCursor: null, attentionHasNext: false };
}

it('restores 1000 proved display rows from persisted cache without batch hydration', async () => {
    storage.setState(storage.getInitialState(), true);
    const serverId = 'persisted-compact-home';
    const credentials = { token: 'persisted-compact-account' };
    const accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
    const rows = createOwnerChoicesPage(1_000).sessions;
    let listedRows = rows;
    const batches: string[][] = [];
    const boundary = createCompactSessionListFetchBoundary(async path => {
        const url = new URL(path, 'https://persisted-compact.test');
        if (url.pathname === '/v2/sessions/read-batch') return undefined;
        if (url.pathname !== '/v2/sessions') return undefined;
        const start = Number(url.searchParams.get('cursor') ?? '0');
        const end = Math.min(start + 200, listedRows.length);
        return Response.json({ sessions: listedRows.slice(start, end),
            nextCursor: end < listedRows.length ? String(end) : null, hasNext: end < listedRows.length });
    });
    const refresh = (cachedSessionListEntries?: Record<string, SessionListCacheEntryV1>, scope = { credentials, accountCurrentness }) => fetchAndApplySessionsSource({
        serverId, ...scope, encryption: null, sessionDataKeys: new Map(),
        contentDemand: 'list-projection', sessionListPageSize: 200, sessionListMaxPages: 5,
        request: async (path, init) => {
            if (path === '/v2/sessions/read-batch') {
                const input: unknown = JSON.parse(String(init.body));
                if (!input || typeof input !== 'object' || !('sessionIds' in input) || !Array.isArray(input.sessionIds)) {
                    throw new Error('Expected a real Session batch request');
                }
                batches.push(input.sessionIds.map(String));
            }
            return boundary(path, init);
        },
        cachedSessionListEntries,
        getExistingSession: id => storage.getState().sessions[id],
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: values => storage.getState().applyServerScopedSessionListRows(serverId, values, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: values => storage.getState().applySessions(values),
        awaitSessionListHydration: true, log: { log() {} },
    });
    await refresh();
    expect(batches.flat()).toEqual(rows.map(row => row.id));
    expect(Object.keys(storage.getState().sessions)).toEqual([]);
    const written = buildSessionListCacheEntriesFromRenderables(storage.getState().sessionListRowsByServerId[serverId] ?? {});
    const restored = Object.fromEntries(Object.entries(written).map(([id, entry]) =>
        [id, SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)))]));
    storage.setState(storage.getInitialState(), true);
    batches.length = 0;
    await refresh(restored);
    expect(batches).toEqual([]);
    const displayed = storage.getState().sessionListRowsByServerId[serverId] ?? {};
    expect(Object.keys(displayed)).toHaveLength(1_000);
    expect(displayed['choice-0']?.metadata).toMatchObject({ path: '/private/0', summaryText: 'Session 0' });
    expect(displayed['choice-999']?.metadata).toMatchObject({ path: '/private/999', summaryText: 'Session 999' });
    expect(Object.keys(storage.getState().sessions)).toEqual([]);
    const first = rows[0]!;
    const firstEntry = restored[first.id]!;
    const { displayProof: _priorProof, ...legacyEntry } = firstEntry;
    const shared = { ...first, ownerMetadata: undefined, agentState: null,
        effectiveAccess: { v: 1 as const, level: 'view' as const,
            sources: [{ kind: 'direct' as const, shareId: 'persisted-display-share' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }) },
        share: { accessLevel: 'view' as const, canApprovePermissions: false } };
    for (const scenario of [
        { row: first, entry: legacyEntry, scope: { credentials, accountCurrentness }, path: '/private/0' },
        { row: first, entry: firstEntry, scope: { credentials: { token: 'replacement-credential' }, accountCurrentness }, path: '/private/0' },
        { row: first, entry: firstEntry, scope: { credentials,
            accountCurrentness: { ...accountCurrentness, updatedAt: accountCurrentness.updatedAt + 1 } }, path: '/private/0' },
        { row: shared, entry: firstEntry, scope: { credentials, accountCurrentness }, path: '' },
    ]) {
        listedRows = [scenario.row];
        storage.setState(storage.getInitialState(), true);
        batches.length = 0;
        await refresh({ [first.id]: scenario.entry }, scenario.scope);
        expect(batches).toEqual([[first.id]]);
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[first.id]?.metadata)
            .toMatchObject({ path: scenario.path, summaryText: 'Session 0' });
        expect(Object.keys(storage.getState().sessions)).toEqual([]);
    }
});

it('refuses a persisted display proof after an equal-version Session key replacement', async () => {
    const serverId = 'persisted-key-home';
    const secret = new Uint8Array(32).fill(73);
    const credentials = { token: 'persisted-key-account', secret: encodeBase64(secret) };
    const accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
    const encryption = await Encryption.create(secret);
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const base = createOwnerChoicesPage(1).sessions[0]!;
    const keyedRow = async (key: Uint8Array, title: string): Promise<V2SessionRecord> => {
        const cipher = await encryption.openEncryption(key);
        const [metadata] = await cipher.encrypt([{ v: 1, summary: { text: title, updatedAt: 1 } }]);
        return { ...base, encryptionMode: 'e2ee', metadata: encodeBase64(metadata!),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)) };
    };
    let row = await keyedRow(new Uint8Array(32).fill(31), 'Before key replacement');
    let batches = 0;
    const boundary = createCompactSessionListFetchBoundary(async path => path === '/v2/sessions/read-batch'
        ? undefined : Response.json({ sessions: [row], nextCursor: null, hasNext: false }));
    const refresh = (cachedSessionListEntries?: Record<string, SessionListCacheEntryV1>) => fetchAndApplySessionsSource({
        serverId, credentials, accountCurrentness, encryption, sessionDataKeys: new Map(), sessionDataKeyEnvelopes: new Map(),
        contentDemand: 'list-projection', cachedSessionListEntries,
        request: async (path, init) => { if (path === '/v2/sessions/read-batch') batches += 1; return boundary(path, init); },
        getExistingSession: id => storage.getState().sessions[id],
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: values => storage.getState().applyServerScopedSessionListRows(serverId, values, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: values => storage.getState().applySessions(values), awaitSessionListHydration: true, log: { log() {} },
    });
    storage.setState(storage.getInitialState(), true);
    await refresh();
    const entry = buildSessionListCacheEntriesFromRenderables(storage.getState().sessionListRowsByServerId[serverId] ?? {})[row.id]!;
    const restored = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)));
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[row.id]?.metadata?.summaryText).toBe('Before key replacement');
    row = await keyedRow(new Uint8Array(32).fill(47), 'After key replacement');
    expect(row.metadataVersion).toBe(restored.metadataVersion);
    storage.setState(storage.getInitialState(), true);
    batches = 0;
    await refresh({ [row.id]: restored });
    expect(batches).toBe(1);
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[row.id]?.metadata?.summaryText).toBe('After key replacement');
    expect(Object.keys(storage.getState().sessions)).toEqual([]);
});

it('reopens owner metadata after a shared-only socket revision instead of proving the retained owner current', async () => {
    storage.setState(storage.getInitialState(), true);
    const serverId = 'socket-owner-revision-home';
    const credentials = { token: 'socket-owner-account' };
    const accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
    const encryption = await Encryption.create(new Uint8Array(32).fill(83));
    const original = { ...createOwnerChoicesPage(1).sessions[0]!,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { name: 'Opened owner N', path: '/owner-n' } }) };
    const currentRow = (id: string) => storage.getState().sessionListRowsByServerId[serverId]?.[id];
    const existing = (id: string) => storage.getState().sessions[id];
    const opened = await fetchAndApplySessionById({ serverId, sessionId: original.id, credentials, accountCurrentness,
        encryption, sessionDataKeys: new Map(), includeTurnsProjection: false,
        prefetched: { detail: { status: 200, body: { session: original } } },
        request: async () => { throw new Error('Unexpected full-reader transport'); },
        getExistingSession: existing, getCurrentSessionListRenderable: currentRow,
        applySessions: values => storage.getState().applySessions(values), log: { log() {} } });
    expect(opened.ok).toBe(true);
    expect(existing(original.id)?.ownerMetadataView?.name).toBe('Opened owner N');
    const shared = JSON.stringify({ v: 1, summary: { text: 'Shared N+1', updatedAt: 2 } });
    const { nextSession } = await buildUpdatedSessionFromSocketUpdate({ session: existing(original.id)!,
        getCurrentSession: () => existing(original.id)!, sessionEncryption: null,
        updateBody: { metadataLayoutVersion: 1, metadata: { version: 2, value: shared } },
        updateSeq: 2, updateCreatedAt: 2 });
    storage.getState().applySessions([nextSession]);
    expect(existing(original.id)?.metadataVersion).toBe(2);
    expect(existing(original.id)?.ownerMetadataView?.name).toBe('Opened owner N');
    const retained = currentRow(original.id)!;
    expect(retained.metadataVersion).toBe(2);
    const entry = buildSessionListCacheEntriesFromRenderables({ [retained.id]: retained })[retained.id]!;
    expect(entry.displayProof).toBeUndefined();
    const restored = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(entry)));
    const fresh = { ...original, metadataVersion: 2, metadata: shared,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { name: 'Fresh owner N+1', path: '/owner-n-plus-one' } }) };
    let batches = 0;
    const boundary = createCompactSessionListFetchBoundary(async path => path === '/v2/sessions/read-batch'
        ? undefined : Response.json({ sessions: [fresh], nextCursor: null, hasNext: false }));
    const refresh = (cachedSessionListEntries?: Record<string, SessionListCacheEntryV1>) => fetchAndApplySessionsSource({
        serverId, credentials, accountCurrentness, encryption, sessionDataKeys: new Map(), contentDemand: 'list-projection',
        cachedSessionListEntries, getExistingSession: existing, getCurrentSessionListRenderable: currentRow,
        request: async (path, init) => { if (path === '/v2/sessions/read-batch') batches += 1; return boundary(path, init); },
        applySessionListRenderables: values => storage.getState().applyServerScopedSessionListRows(serverId, values, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: values => storage.getState().applySessions(values), awaitSessionListHydration: true, log: { log() {} },
    });
    await refresh();
    expect(batches).toBe(1);
    expect(currentRow(original.id)?.metadata).toMatchObject({ name: 'Fresh owner N+1', path: '/owner-n-plus-one' });
    storage.setState(storage.getInitialState(), true);
    batches = 0;
    await refresh({ [original.id]: restored });
    expect(batches).toBe(1);
    expect(currentRow(original.id)?.metadata).toMatchObject({ name: 'Fresh owner N+1', path: '/owner-n-plus-one' });
    expect(Object.keys(storage.getState().sessions)).toEqual([]);
});



it('projects Account-opened full-detail owner envelopes through the shared title and mention readers', async () => {
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: 'owner-title', secret: encodeBase64(secret) };
    const currentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    const encryption = await Encryption.create(secret);
    const cipher = await encryption.openEncryption(new Uint8Array(32).fill(29));
    const [sharedMetadata] = await cipher.encrypt([{ v: 1, summary: { text: 'Not opened shared title', updatedAt: 1 } }]);
    const base = createOwnerChoicesPage().sessions[0]!;
    const ownerEnvelope = (name?: string, key = secret) => ownerEnvelopes.sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'legacy', secret: key }, ownerMetadata: { v: 1,
            workspace: { path: '/private/owner-worktree', host: 'private-owner-host', ...(name ? { name } : {}) } },
        randomBytes: length => new Uint8Array(length).fill(11),
    });
    const rows = [
        { ...base, id: 'named-owner', ownerMetadata: ownerEnvelope('Owner release review') },
        { ...base, id: 'untitled-owner', ownerMetadata: ownerEnvelope() },
        { ...base, id: 'unreadable-owner', ownerMetadata: ownerEnvelope('Must not disclose', new Uint8Array(32).fill(53)) },
        { ...base, id: 'foreign-recipient', ownerMetadata: null, effectiveAccess: { v: 1 as const, level: 'view' as const,
            sources: [{ kind: 'team' as const, teamId: 'team', requiredByTeamPolicy: false }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }) } },
    ].map(row => ({ ...row, encryptionMode: 'e2ee' as const, metadata: encodeBase64(sharedMetadata!), dataEncryptionKey: null }));
    const home = 'owner-title-home';
    const projected = Object.fromEntries(rows.map(row => [row.id, buildRenderableFromRowAndCache(row, credentials, currentness, undefined)]));
    storage.setState({ sessions: { 'named-owner': createSessionFixture({ id: 'named-owner', serverId: 'other-home',
        metadata: { name: 'Wrong Home', host: 'other', path: '/wrong' } }) }, sessionListRowsByServerId: { [home]: projected } });
    const addresses = rows.map(row => ({ serverId: home, sessionId: row.id }));
    const titles = await renderHook(() => useSessionDisplayTitles(addresses));
    expect(titles.getCurrent()).toEqual(['Owner release review', t('session.untitled'),
        t('session.access.lockedTitleFallback'), t('session.access.lockedTitleFallback')]);
    const readable = await renderHook(() => useSessionDisplayNameProjections(addresses, readableSessionDisplayTitle));
    expect(readable.getCurrent()).toEqual(['Owner release review', t('session.untitled'), null, null]);
    expect(addresses.map(address => readComposerSessionSuggestionDisplay(address)?.title)).toEqual(titles.getCurrent());
    expect(rows.map(row => encryption.getSessionEncryption(row.id))).toEqual([null, null, null, null]);
    expect(rows.map(row => projected[row.id]!.encryptedContentAvailability)).toEqual([undefined, undefined, 'encrypted_content_unavailable', undefined]);
    expect(projected['named-owner']?.metadata?.path).toBe('');
    expect(projected['named-owner']?.metadata?.host).not.toBe('private-owner-host');
    const retained = titles.getCurrent();
    await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions,
        'named-owner': { ...state.sessions['named-owner']!, thinking: true, metadata: { name: 'Other Home changed', host: 'other', path: '/wrong' } },
    } })); });
    expect(titles.getCurrent()).toBe(retained);
    const changedRow = { ...rows[0]!, ownerMetadata: ownerEnvelope('Renamed owner') };
    await act(async () => { storage.setState({ sessionListRowsByServerId: { [home]: { ...projected,
        'named-owner': buildRenderableFromRowAndCache(changedRow, credentials, currentness, undefined, undefined, projected['named-owner']),
    } } }); });
    expect(titles.getCurrent()[0]).toBe('Renamed owner');
    await act(async () => { storage.setState({ sessionListRowsByServerId: { [home]: { ...projected,
        'named-owner': buildRenderableFromRowAndCache({ ...changedRow, ownerMetadata: ownerEnvelope() }, credentials, currentness, undefined,
            undefined, storage.getState().sessionListRowsByServerId[home]!['named-owner']),
    } } }); });
    expect(titles.getCurrent()[0]).toBe(t('session.untitled'));
});

it('hydrates missing cold compact display facts before applying their visibility', async () => {
    const secret = new Uint8Array(32).fill(31);
    const credentials = { token: 'visibility', secret: encodeBase64(secret) };
    const accountCurrentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    const encryption = await Encryption.create(secret);
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const serverId = 'cold-owner-visibility-home';
    const rows = await Promise.all(createOwnerChoicesPage().sessions.slice(0, 3).map(async (row, index) => {
        const key = new Uint8Array(32).fill(41 + index);
        const cipher = await encryption.openEncryption(key);
        const [metadata] = await cipher.encrypt([{ v: 1, summary: { text: `Private title ${index}`, updatedAt: 1 } }]);
        return { ...row, encryptionMode: 'e2ee' as const,
            metadata: encodeBase64(metadata!),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            ownerMetadata: ownerEnvelopes.sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy', secret: index === 2 ? new Uint8Array(32).fill(91) : secret },
                ownerMetadata: { v: 1, workspace: { path: `/private/${index}` },
                    ...(index === 1 ? { system: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } } : {}) },
                randomBytes: length => new Uint8Array(length).fill(index + 1),
            }),
        };
    }));
    const openDataKey = vi.spyOn(dataKeyEnvelopes, 'openEncryptedDataKeyEnvelopeV1');
    const refresh = () => fetchAndApplySessions({
        serverId, credentials, encryption,
        accountCurrentness,
        sessionDataKeys: new Map(),
        request: async () => Response.json({ sessions: rows, nextCursor: null, hasNext: false }),
        getExistingSession: id => storage.getState().sessions[id],
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: values => storage.getState().applyServerScopedSessionListRows(serverId, values, { source: 'ordinary', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: values => storage.getState().applySessions(values),
        awaitSessionListHydration: true,
        log: { log() {} },
    });
    await refresh();
    const state = storage.getState();
    const index = state.sessionListIndexByServerId[serverId] ?? null;
    expect(resolveVisibleSessionListIndexSummary({ enabled: false, activeServerId: serverId, activeIndex: index }))
        .toEqual({ sessionsReady: true, sessionCount: 1 });
    expect(index?.flatMap(item => item.type === 'session' ? [item.sessionId] : [])).toEqual(['choice-0']);
    const projected = state.sessionListRowsByServerId[serverId]!;
    expect(rows.map(row => isUserFacingSession(projected[row.id]!))).toEqual([true, false, false]);
    expect(projected['choice-0']?.metadata?.path).toBe('/private/0');
    expect(projected['choice-1']?.metadata?.hiddenSystemSession).toBe(true);
    expect(projected['choice-2']?.metadataUnavailable).toBe(true);
    expect(rows.map(row => state.sessions[row.id])).toEqual([undefined, undefined, undefined]);
    expect(encryption.getSessionEncryption('choice-0')).not.toBeNull();
    expect(projected['choice-0']?.[SESSION_OWNER_METADATA_PROJECTION]?.kind).toBe('owner');
    expect(readSessionListRenderableOwnerMetadataView(projected['choice-0']!, {
        requireAdmitted: { credentials, accountMode: 'e2ee', accountCurrentness, isCurrent: () => true },
    })).toMatchObject({ path: '/private/0' });
    expect(openDataKey).toHaveBeenCalled();

    // A new metadata revision must replace retained display facts and apply a
    // newly proved owner-hidden fact through the same full-read fallback.
    storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: 'choice-0', patch: {
        metadata: { ...projected['choice-0']!.metadata, path: '/retained/worktree', summaryText: 'Retained title' },
    } }]);
    rows[0] = { ...rows[0]!, metadataVersion: 2, ownerMetadata: ownerEnvelopes.sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'legacy', secret },
        ownerMetadata: { v: 1, workspace: { path: '/private/0' },
            system: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
        randomBytes: length => new Uint8Array(length).fill(11),
    }) };
    await refresh();
    const refreshed = storage.getState();
    expect(refreshed.sessionListRowsByServerId[serverId]?.['choice-0']?.metadata).toMatchObject({
        path: '/private/0', summaryText: 'Private title 0', hiddenSystemSession: true,
    });
    expect(resolveVisibleSessionListIndexSummary({ enabled: false, activeServerId: serverId,
        activeIndex: refreshed.sessionListIndexByServerId[serverId] ?? null })).toEqual({ sessionsReady: true, sessionCount: 0 });
    expect(rows.map(row => refreshed.sessions[row.id])).toEqual([undefined, undefined, undefined]);
    expect(openDataKey).toHaveBeenCalled();
});

it('opens an unchanged owner envelope once and retains unrelated scoped row subscriptions', async () => {
    const secret = new Uint8Array(32).fill(7);
    const credentials = { token: 'owner-projection-test', secret: encodeBase64(secret, 'base64') };
    const accountCurrentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    const body = createOwnerChoicesPage();
    body.sessions = body.sessions.slice(0, 2).map(row => ({ ...row,
        ownerMetadata: ownerEnvelopes.sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'legacy', secret },
            ownerMetadata: { v: 1, workspace: { path: '/owner-projection' } },
            randomBytes: length => new Uint8Array(length).fill(row.id === 'choice-0' ? 1 : 2),
        }),
    }));
    const open = vi.spyOn(ownerEnvelopes, 'openSessionOwnerMetadataEnvelopeV1');
    const openValue = vi.spyOn(ownerEnvelopes, 'openSessionOwnerMetadataV1');
    const projectOwner = vi.spyOn(metadataSchemas, 'projectSessionOwnerCompatibilityViewV1');
    const opens = () => open.mock.calls.length + openValue.mock.calls.length;
    const serverId = 'owner-projection-home';
    const readRows = () => storage.getState().sessionListRowsByServerId[serverId] ?? {};
    const refresh = () => fetchAndApplySessions({
        serverId, credentials, encryption: null, sessionDataKeys: new Map(),
        accountCurrentness,
        request: async () => Response.json(body),
        getExistingSession: id => storage.getState().sessions[id],
        getCurrentSessionListRenderable: id => readRows()[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows),
        awaitSessionListHydration: true,
        log: { log() {} },
    });
    await refresh();
    expect(readRows()['choice-0']?.metadata?.path).toBe('/owner-projection');
    expect(opens()).toBe(2);
    expect(projectOwner).toHaveBeenCalledTimes(2);
    const admission = { credentials: { ...credentials }, accountCurrentness, isCurrent: () => true };
    expect(readSessionListRenderableOwnerMetadataView(readRows()['choice-0']!, { requireAdmitted: admission }))
        .toMatchObject({ path: '/owner-projection' });
    expect(readSessionListRenderableOwnerMetadataView(readRows()['choice-0']!, { requireAdmitted: { ...admission,
        accountCurrentness: { ...accountCurrentness, contentKeyFingerprint: 'changed-content' },
    } })).toBeNull();
    const unchanged = readRows()['choice-1'];
    let unrelatedUpdates = 0;
    const unsubscribe = storage.subscribe((next, previous) => {
        if (next.sessionListRowsByServerId[serverId]?.['choice-1'] !== previous.sessionListRowsByServerId[serverId]?.['choice-1']) unrelatedUpdates++;
    });
    try {
        await refresh();
        expect(opens()).toBe(2);
        expect(projectOwner).toHaveBeenCalledTimes(2);
        body.sessions[0] = { ...body.sessions[0]!, updatedAt: 2, seq: 2, metadataVersion: 2,
            metadata: JSON.stringify({ v: 1, summary: { text: 'Updated', updatedAt: 2 } }),
        };
        await refresh();
        expect(opens()).toBe(2);
        expect(readRows()['choice-0']?.metadata?.summaryText).toBe('Updated');
        expect(projectOwner).toHaveBeenCalledTimes(3);
        expect(readRows()['choice-1']).toBe(unchanged);
        expect(unrelatedUpdates).toBe(0);
        const retainedEnvelope = body.sessions[0]!.ownerMetadata;
        if (retainedEnvelope?.t !== 'encrypted') throw new Error('Expected encrypted owner fixture');
        const invalidCiphertext = `${retainedEnvelope.c}\n`;
        body.sessions[0] = { ...body.sessions[0]!, ownerMetadata: { t: 'encrypted', c: invalidCiphertext } };
        await expect(refresh()).rejects.toThrow();
        expect(readRows()['choice-1']).toBe(unchanged);
        const changedEnvelope = ownerEnvelopes.sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'legacy', secret }, ownerMetadata: { v: 1, workspace: { path: '/owner-projection/changed' } },
            randomBytes: length => new Uint8Array(length).fill(9),
        });
        if (changedEnvelope.t !== 'encrypted') throw new Error('Expected encrypted owner fixture');
        body.sessions[0] = { ...body.sessions[0]!, seq: 3, updatedAt: 3, metadataVersion: 3, ownerMetadata: changedEnvelope };
        await refresh();
        expect(opens()).toBe(3);
        expect(readRows()['choice-0']?.metadata?.path).toBe('/owner-projection/changed');
        await refresh();
        expect(opens()).toBe(3);
    } finally { unsubscribe(); }
});

it.each([
    { queryMs: 245, currentnessMs: 9216 },
    // Resume 7 resource totals: 5946.4 ms and 3964.8 ms (rounded up to a timer millisecond).
    { queryMs: 5946.4, currentnessMs: 3965 },
])('publishes owner query choices without serializing independent reads ($queryMs / $currentnessMs ms)', async ({ queryMs, currentnessMs }) => {
    // Recorded HTTP latency is the only substitution. Parsing, Account-mode
    // validation, owner projection, snapshot publication and the store are real.
    vi.useFakeTimers();
    const startedAt = Date.now();
    let publishedAt: number | undefined;
    const requests: Array<{ path: string; at: number }> = [];
    const body = createOwnerChoicesPage();
    const pending = fetchAndApplySessions({
        serverId: 'latency-home', credentials: { token: 'latency' }, encryption: null, sessionDataKeys: new Map(),
        source: { kind: 'query', allowV1Fallback: false, body: { ...QUERY, scope: 'all_accessible', includeAttention: false } },
        request: async (path) => {
            requests.push({ path, at: Date.now() - startedAt });
            await new Promise(resolve => setTimeout(resolve, path === '/v2/sessions/query' ? queryMs : currentnessMs));
            return Response.json(path === '/v2/sessions/query' ? body : createPlainAccountEncryptionCurrentnessFixture());
        },
        getExistingSession: () => null,
        applySessionListRenderables: (renderables) => {
            publishedAt = Date.now() - startedAt;
            storage.getState().applyServerScopedSessionListRows('latency-home', renderables, { source: 'rowOnly', mode: 'replace' });
        },
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches('latency-home', patches),
        applySessions() {}, log: { log() {} },
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.current).toBe(true);
    const stored = storage.getState().sessionListRowsByServerId['latency-home'];
    expect(Object.keys(stored ?? {})).toHaveLength(6);
    expect(stored?.['choice-0']?.metadata?.path).toBe('/private/0');
    console.info('SESSION_CHOICES_LATENCY_MEASUREMENT', JSON.stringify({ queryMs, currentnessMs, publishedAt, requests }));
    expect(publishedAt).toBeLessThanOrEqual(Math.max(queryMs, currentnessMs));
});

it.each(['unavailable-authority', 'retired-read', 'empty-query'] as const)(
    'keeps the query publication boundary safe for %s', async scenario => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const body = createOwnerChoicesPage();
        const pending = fetchAndApplySessions({
            serverId: 'guard-home', credentials: { token: 'guard' }, encryption: null, sessionDataKeys: new Map(),
            source: { kind: 'query', allowV1Fallback: false, body: { ...QUERY, scope: 'all_accessible', includeAttention: false } },
            signal: controller.signal,
            request: async (path, init) => {
                expect(init.signal).toBe(controller.signal);
                await new Promise(resolve => setTimeout(resolve, path === '/v2/sessions/query' ? 10 : 100));
                if (path === '/v2/sessions/query') return Response.json(scenario === 'empty-query' ? { ...body, sessions: [] } : body);
                return scenario === 'retired-read' ? Response.json(createPlainAccountEncryptionCurrentnessFixture())
                    : Response.json({}, { status: 503 });
            },
            getExistingSession: () => null,
            applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows('guard-home', rows, { source: 'rowOnly', mode: 'replace' }),
            applySessions() {}, log: { log() {} },
        }).then(result => ({ result }), (error: unknown) => ({ error }));
        if (scenario === 'retired-read') {
            await vi.advanceTimersByTimeAsync(20);
            controller.abort();
        }
        await vi.runAllTimersAsync();
        const outcome = await pending;
        if (scenario === 'unavailable-authority') {
            expect(outcome).toMatchObject({ error: { code: 'account-encryption-currentness-unavailable' } });
        } else if (scenario === 'retired-read') {
            expect(outcome).toMatchObject({ error: { name: 'AbortError' } });
        } else {
            expect(outcome).toMatchObject({ result: { current: scenario === 'empty-query', sessionIds: scenario === 'empty-query' ? [] : body.sessions.map(row => row.id) } });
        }
        expect(Object.keys(storage.getState().sessionListRowsByServerId['guard-home'] ?? {})).toHaveLength(0);
    },
);

function measurements() {
    return syncPerformanceTelemetry.snapshot().events
        .filter((event) => /decryptDataKeys|initializeSessions|decryptRows|decryptRow$/.test(event.name))
        .map(({ name, count, totalMs, maxMs }) => ({ name, count, totalMs, maxMs }));
}

it('measures real encrypted hydration and rapid query replacement across three fifty-row Homes', async () => {
    // Only HTTP is substituted. The repository Node adapters execute real libsodium
    // envelope opens and WebCrypto AES; this does not measure a native bridge.
    const homes = await Promise.all(Array.from({ length: 3 }, async (_, homeIndex) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(homeIndex + 1));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const rows = await Promise.all(Array.from({ length: 50 }, async (_, rowIndex): Promise<V2SessionRecord> => {
            const id = `session-${rowIndex}`;
            const key = new Uint8Array(32).fill(rowIndex + 10);
            const cipher = await encryption.openEncryption(key);
            const encrypted = await cipher.encrypt([
                { path: `/workspace/project-${rowIndex % 10}`, host: `home-${homeIndex}`, summary: { text: `Session ${rowIndex}`, updatedAt: 1 } },
                { requests: {}, completedRequests: {} },
            ]);
            return {
                id, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
                archivedAt: null, encryptionMode: 'e2ee',
                metadata: encodeBase64(encrypted[0]!, 'base64'), metadataVersion: 1,
                agentState: encodeBase64(encrypted[1]!, 'base64'), agentStateVersion: 1,
                dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64'),
                share: null,
                effectiveAccess: {
                    v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
                },
                viewer: {
                    latestFailureSeq: null,
                    readState: { state: 'not_started' },
                    relevance: { relevant: true, reasons: ['owned_by_me'] },
                    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                    follow: { follows: false, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                },
                responsibleAccountId: null,
                responsibleAccount: null,
            };
        }));
        // Validate the complete HTTP fixture before either timed workload. Strict
        // queries require current viewer/access/responsibility and both frontiers.
        const page = {
            sessions: rows, nextCursor: null, hasNext: false,
            attentionNextCursor: null, attentionHasNext: false,
        };
        SessionListQueryResponseV1Schema.parse({ ...page, sessions: rows.map(createCompactSessionListRowFixture) });
        const queryBody = JSON.stringify(page);
        const ordinaryBody = JSON.stringify({ sessions: rows, nextCursor: null, hasNext: false });
        return {
            encryption, serverId: `home-${homeIndex}`,
            sessionDataKeys: new Map<string, Uint8Array>(), sessionDataKeyEnvelopes: new Map<string, string>(),
            request: async (path: string) => new Response(
                path === '/v2/sessions/query' ? queryBody : ordinaryBody,
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        };
    }));

    syncPerformanceTelemetry.configure({ enabled: true });
    syncPerformanceTelemetry.reset();
    const started = performance.now();
    const hydrated = await Promise.all(homes.map(async (home) => {
        const titles: string[] = [];
        await fetchAndApplySessions({
            serverId: home.serverId,
            credentials: { token: 'benchmark', secret: encodeBase64(new Uint8Array(32).fill(1), 'base64') },
            encryption: home.encryption,
            sessionDataKeys: home.sessionDataKeys,
            sessionDataKeyEnvelopes: home.sessionDataKeyEnvelopes,
            request: home.request,
            sessionListHydrationConcurrencyLimit: 4,
            applySessions: (rows) => titles.push(...rows.map((row) => row.metadata?.summary?.text ?? 'unreadable')),
            log: { log() {} },
        });
        expect(titles).toHaveLength(50);
        expect(titles).not.toContain('unreadable');
        return titles.length;
    }));
    const hydrationMs = performance.now() - started;
    const hydration = measurements();
    expect(hydrated.reduce((sum, count) => sum + count, 0)).toBe(150);

    syncPerformanceTelemetry.reset();
    let requests = 0;
    const controllers = homes.map((home) => createSessionListQueryHomeController({
        serverId: home.serverId,
        fetchPage: async ({ source, signal, membership }) => {
            requests += 1;
            return fetchAndApplySessions({
                serverId: home.serverId, source, signal,
                credentials: { token: 'benchmark', secret: encodeBase64(new Uint8Array(32).fill(1), 'base64') },
                encryption: home.encryption,
                sessionDataKeys: home.sessionDataKeys,
                sessionDataKeyEnvelopes: home.sessionDataKeyEnvelopes,
                request: home.request,
                shouldContinue: () => !signal.aborted,
                getExistingSession: () => null,
                getCurrentSessionListRenderable: (sessionId) => (
                    storage.getState().sessionListRowsByServerId[home.serverId]?.[sessionId] ?? null
                ),
                applySessionListRenderables: (rows) => {
                    if (signal.aborted) return;
                    storage.getState().applyServerScopedSessionListRows(home.serverId, rows, {
                        source: membership, mode: 'replace',
                    });
                },
                applySessionListRenderablePatches: (patches) => {
                    if (signal.aborted) return;
                    storage.getState().applyServerScopedSessionListRowPatches(home.serverId, patches);
                },
                // Production query adapters publish scoped rows and patches, never full Sessions.
                applySessions() {},
                log: { log() {} },
            });
        },
    }));
    const rapidStarted = performance.now();
    const pending: Promise<void>[] = [];
    try {
        for (let change = 0; change < 5; change += 1) {
            for (const controller of controllers) {
                pending.push(controller.update({
                    query: { ...QUERY, tagIds: [`tag-${change}`] },
                    selected: true, online: true, supported: true,
                }));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await Promise.all(pending);
        const rapidQueryMs = performance.now() - rapidStarted;
        // The controller derives corpus identity itself and refuses a caller's, so the
        // settled key is the canonical one for the last requested query — asserted
        // through its owner rather than a literal the controller can never produce.
        const lastQuery: SessionListQueryV1 = { ...QUERY, tagIds: ['tag-4'] };
        for (const home of homes.map((home, index) => ({ home, controller: controllers[index]! }))) {
            expect(home.controller.getSnapshot()).toMatchObject({ phase: 'ready', failureCode: null });
            expect(home.controller.getSnapshot().appliedQueryKey)
                .toBe(buildSessionListQueryKey(home.home.serverId, lastQuery));
            expect(home.controller.getSnapshot().addresses).toHaveLength(50);
            expect(storage.getState().ordinarySessionListMembershipByServerId[home.home.serverId]).toBeUndefined();
        }
        console.info('SESSION_HYDRATION_MEASUREMENT', JSON.stringify({
            platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
            homes: 3, rowsPerHome: 50, metadataAndAgentStateCiphertexts: 300,
            crypto: 'real libsodium + WebCrypto AES; native worker off',
            hydrationMs, hydration, rapidChangesPerHome: 5, requests, rapidQueryMs,
            rapidHydration: measurements(),
        }));
    } finally {
        controllers.forEach((controller) => controller.dispose());
        await Promise.allSettled(pending);
    }
}, 60_000);
