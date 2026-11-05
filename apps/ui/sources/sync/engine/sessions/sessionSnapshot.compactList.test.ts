import { afterEach, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { buildSessionListCacheEntriesFromRenderables } from '@/sync/domains/state/warmCacheAdapters';
import { createSessionFixture } from '@/dev/testkit';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { buildSessionListRenderableFromSession, SESSION_LIST_DOCUMENT_ADMISSION } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildRenderableFromRowAndCache, fetchAndApplySessions } from './sessionSnapshot';
import { fetchAndApplySessionById } from './sessionById';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createCompactSessionListRowFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

const initialState = storage.getState();
afterEach(() => { vi.restoreAllMocks(); storage.setState(initialState, true); });

it('keeps the last opened Session when background hydration fails without sending diagnostics to the error toast', async () => {
    const serverId = 'background-failure-home';
    let row = { id: 'background-failure', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain' as const, metadataLayoutVersion: 0, metadataVersion: 1, agentStateVersion: 0,
        metadata: JSON.stringify({ path: '/background-failure', host: 'home', name: 'Last opened Session' }),
        agentState: null, dataEncryptionKey: null, share: null };
    const errorToast = vi.spyOn(console, 'error').mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, 'info').mockImplementation(() => {});
    const failure = new Error('Background scheduling failed');
    const refresh = (background: boolean, fail = false) => fetchAndApplySessions({
        serverId, credentials: { token: 'background-failure-account' },
        accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(), encryption: null, sessionDataKeys: new Map(),
        requiredHydrationSessionIds: background ? [] : [row.id], awaitSessionListHydration: !background,
        sessionListEagerHydrationCount: 1,
        // Scheduling is an OS boundary; keep snapshot parsing, hydration and publication real.
        sessionListBackgroundHydrationYield: async () => { if (fail) throw failure; },
        request: async path => path === '/v2/sessions/read-batch'
            ? Response.json({ results: [{ sessionId: row.id, detail: { status: 200, body: { session: row } } }] })
            : Response.json({ sessions: [createCompactSessionListRowFixture(row)] }),
        getExistingSession: id => storage.getState().sessions[id],
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    await refresh(false);
    const retained = storage.getState().sessions[row.id];
    expect(retained?.metadata?.name).toBe('Last opened Session');
    row = { ...row, seq: 2, updatedAt: 2, metadataVersion: 2,
        metadata: JSON.stringify({ path: '/background-failure', host: 'home', name: 'Refreshed Session' }) };
    await refresh(true, true);
    await vi.waitFor(() => expect(errorToast.mock.calls.length + diagnostics.mock.calls.length).toBeGreaterThan(0));
    expect(errorToast).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('sessionsSnapshot'), failure);
    expect(storage.getState().sessions[row.id]?.metadata).toBe(retained?.metadata);
    expect(storage.getState().sessions[row.id]?.metadataVersion).toBe(1);
    // The existing explicit refresh can still recover and publish the new document.
    await refresh(false);
    expect(storage.getState().sessions[row.id]?.metadata?.name).toBe('Refreshed Session');
});

it.each(['e2ee', 'plain'] as const)('preserves an opened Agent-state document when newer metadata opens but %s Agent-state cannot open', async encryptionMode => {
    const errorToast = vi.spyOn(console, 'error').mockImplementation(() => {});
    const diagnostics = vi.spyOn(console, 'info').mockImplementation(() => {});
    const serverId = 'partial-state-home';
    const id = 'partial-state';
    const secret = new Uint8Array(32).fill(51);
    const key = new Uint8Array(32).fill(52);
    const credentials = { token: 'partial-state-account', secret: encodeBase64(secret) };
    const accountCurrentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    const encryption = await Encryption.create(secret);
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    await encryption.initializeSessions(new Map([[id, key]]), { serverId });
    const reader = encryption.getSessionEncryption(id)!;
    const oldState = { requests: { retained: { tool: 'Bash', arguments: { command: 'git status' }, createdAt: 1 } } };
    const full = { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode, metadataLayoutVersion: 0, metadataVersion: 1, agentStateVersion: 1,
        metadata: encryptionMode === 'plain' ? JSON.stringify({ path: '/partial-state', host: 'home', name: 'Original metadata' })
            : await reader.encryptRaw({ path: '/partial-state', host: 'home', name: 'Original metadata' }),
        agentState: encryptionMode === 'plain' ? JSON.stringify(oldState) : await reader.encryptRaw(oldState),
        dataEncryptionKey: encryptionMode === 'plain' ? null : encodeBase64(await encryption.encryptEncryptionKey(key)),
        share: null, pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 };
    const getExistingSession = (sessionId: string) => storage.getState().sessions[sessionId];
    const getCurrentSessionListRenderable = (sessionId: string) => storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
    const initial = await fetchAndApplySessionById({ serverId, sessionId: id, credentials, accountCurrentness, encryption,
        sessionDataKeys: new Map(), includeTurnsProjection: false, prefetched: { detail: { status: 200, body: { session: full } } },
        request: async () => { throw new Error('Unexpected exact transport'); }, getExistingSession,
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    expect(initial.ok).toBe(true);
    const retainedState = getExistingSession(id)!.agentState;
    const wrongCipher = await encryption.openEncryption(new Uint8Array(32).fill(53));
    const fresh = { ...full, metadataVersion: 2, agentStateVersion: 2,
        metadata: encryptionMode === 'plain' ? JSON.stringify({ path: '/partial-state', host: 'home', name: 'Fresh metadata' })
            : await reader.encryptRaw({ path: '/partial-state', host: 'home', name: 'Fresh metadata' }),
        agentState: encryptionMode === 'plain' ? '{' : encodeBase64((await wrongCipher.encrypt([{}]))[0]!) };
    await fetchAndApplySessions({ serverId, credentials, accountCurrentness, encryption, sessionDataKeys: new Map(),
        requiredHydrationSessionIds: [id], awaitSessionListHydration: true,
        request: async path => path === '/v2/sessions/read-batch'
            ? Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: fresh } } }] })
            : Response.json({ sessions: [createCompactSessionListRowFixture(fresh)] }),
        getExistingSession, getCurrentSessionListRenderable,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    expect(getExistingSession(id)?.metadata?.name).toBe('Fresh metadata');
    expect(getExistingSession(id)?.agentState).toBe(retainedState);
    expect(getExistingSession(id)?.agentStateVersion).toBe(1);
    expect(getCurrentSessionListRenderable(id)?.hasPendingPermissionRequests).toBe(true);
    expect(errorToast).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining('sessionsSnapshot'));
});

it('does not let an older failed display open lock a newer admitted display', async () => {
    const serverId = 'display-failure-home';
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: 'display-failure-account', secret: encodeBase64(secret) };
    const accountCurrentness = createLegacyAccountEncryptionCurrentnessFixture({ secret });
    const ownerEnvelope = (materialSecret: Uint8Array, name: string) => sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'legacy', secret: materialSecret },
        ownerMetadata: { v: 1, workspace: { name, path: '/display-failure', host: 'localhost' } },
        randomBytes: length => new Uint8Array(length).fill(3),
    });
    const old = { ...createPlainSessionCurrentProjectionRecordFixture({ id: 'display-failure', metadataVersion: 1,
        metadata: { path: '/display-failure', name: 'Old owner', host: 'localhost' } }),
        metadata: JSON.stringify({ v: 1, summary: { text: 'Old shared title', updatedAt: 1 } }),
        ownerMetadata: ownerEnvelope(new Uint8Array(32).fill(18), 'Unreadable old owner') };
    const fresh = { ...old, metadataVersion: 2,
        metadata: JSON.stringify({ v: 1, summary: { text: 'Fresh shared title', updatedAt: 2 } }),
        ownerMetadata: ownerEnvelope(secret, 'Fresh owner') };
    const encryption = await Encryption.create(secret);
    let batchStarted!: () => void;
    let releaseBatch!: () => void;
    const started = new Promise<void>(resolve => { batchStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseBatch = resolve; });
    const getCurrentSessionListRenderable = (id: string) => storage.getState().sessionListRowsByServerId[serverId]?.[id];
    const refreshing = fetchAndApplySessions({ serverId, credentials, accountCurrentness, encryption,
        contentDemand: 'list-projection', sessionDataKeys: new Map(),
        request: async path => {
            if (path !== '/v2/sessions/read-batch') return Response.json({ sessions: [createCompactSessionListRowFixture(old)] });
            batchStarted(); await gate;
            return Response.json({ results: [{ sessionId: old.id, detail: { status: 200, body: { session: old } } }] });
        },
        getCurrentSessionListRenderable,
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    await started;
    const opened = await fetchAndApplySessionById({ serverId, sessionId: fresh.id, credentials, accountCurrentness,
        encryption, sessionDataKeys: new Map(), includeTurnsProjection: false,
        prefetched: { detail: { status: 200, body: { session: fresh } } },
        request: async () => { throw new Error('Unexpected exact transport'); },
        getCurrentSessionListRenderable, getExistingSession: id => storage.getState().sessions[id],
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    expect(opened.ok).toBe(true);
    expect(getCurrentSessionListRenderable(old.id)?.metadata?.name).toBe('Fresh owner');
    releaseBatch(); await refreshing;
    expect(getCurrentSessionListRenderable(old.id)).toMatchObject({ metadataVersion: 2,
        metadata: { name: 'Fresh owner' }, encryptedContentAvailability: 'ready' });
    expect(getCurrentSessionListRenderable(old.id)?.metadataUnavailable).not.toBe(true);
    expect(storage.getState().sessions[old.id]?.metadataVersion).toBe(2);
});

it('does not publish display documents opened after their encryption generation retires', async () => {
    const serverId = 'display-generation-home';
    const secret = new Uint8Array(32).fill(31);
    const encryption = await Encryption.create(secret);
    encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
    const key = new Uint8Array(32).fill(41);
    const cipher = await encryption.openEncryption(key);
    const [metadata] = await cipher.encrypt([{ path: '/retired-display', host: 'home', name: 'Retired document' }]);
    const full = { id: 'retired-display', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: 'e2ee' as const, metadataLayoutVersion: 0, metadataVersion: 1, agentStateVersion: 0,
        metadata: encodeBase64(metadata!), agentState: null, dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)), share: null };
    let releaseOpen!: () => void;
    let openingStarted!: () => void;
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
    const started = new Promise<void>(resolve => { openingStarted = resolve; });
    const initialize = encryption.initializeSessions.bind(encryption);
    vi.spyOn(encryption, 'initializeSessions').mockImplementation(async (...args) => {
        const scope = await initialize(...args);
        const reader = encryption.getSessionEncryption(full.id)!;
        const open = reader.decryptMetadata.bind(reader);
        // Delay the genuine cryptographic boundary while its owning generation changes.
        vi.spyOn(reader, 'decryptMetadata').mockImplementation(async (...openArgs) => {
            openingStarted(); await openGate; return open(...openArgs);
        });
        return scope;
    });
    const { metadata: _metadata, agentState: _agentState, ...scalars } = full;
    const refreshing = fetchAndApplySessions({ serverId, credentials: { token: 'display-account', secret: encodeBase64(secret) },
        encryption, sessionDataKeys: new Map(), request: async path => path === '/v2/sessions/read-batch'
            ? Response.json({ results: [{ sessionId: full.id, detail: { status: 200, body: { session: full } } }] })
            : Response.json({ sessions: [{ ...scalars, documents: 'omitted', metadataAudience: 'owner', agentStateDocument: 'omitted' }] }),
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    await started;
    encryption.removeSessionEncryption(full.id);
    releaseOpen();
    await refreshing;
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[full.id]?.metadata).toBeNull();
    expect(storage.getState().sessions[full.id]).toBeUndefined();
});

it('reuses documents opened by the authoritative full reader on the next compact refresh', async () => {
    const serverId = 'exact-open-home';
    const credentials = { token: 'exact-open-account' };
    const accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
    const full = { id: 'exact-open', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain' as const, metadataLayoutVersion: 0, metadataVersion: 1, agentStateVersion: 0,
        metadata: JSON.stringify({ path: '/exact', host: 'home', name: 'Exact reader label' }),
        agentState: null, dataEncryptionKey: null, share: null };
    const getExistingSession = (id: string) => storage.getState().sessions[id];
    const result = await fetchAndApplySessionById({ serverId, sessionId: full.id, credentials, accountCurrentness,
        encryption: await Encryption.create(new Uint8Array(32).fill(7)), sessionDataKeys: new Map(), includeTurnsProjection: false,
        prefetched: { detail: { status: 200, body: { session: full } } }, request: async () => { throw new Error('Unexpected transport'); },
        getExistingSession, applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    expect(result.ok).toBe(true);
    // A full Session retained from before this reader issued custody has identical ordinary
    // fields. Reopening it must still install the witness through the real store comparator.
    const { [SESSION_LIST_DOCUMENT_ADMISSION]: _oldAdmission, ...retainedSession } = storage.getState().sessions[full.id]!;
    storage.setState({ sessions: { ...storage.getState().sessions, [full.id]: retainedSession } });
    await fetchAndApplySessionById({ serverId, sessionId: full.id, credentials, accountCurrentness,
        encryption: await Encryption.create(new Uint8Array(32).fill(7)), sessionDataKeys: new Map(), includeTurnsProjection: false,
        prefetched: { detail: { status: 200, body: { session: full } } }, request: async () => { throw new Error('Unexpected transport'); },
        getExistingSession, applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    const { metadata: _metadata, agentState: _agentState, ...scalars } = full;
    let bodyReads = 0;
    await fetchAndApplySessions({ serverId, credentials, accountCurrentness, encryption: null, sessionDataKeys: new Map(),
        requiredHydrationSessionIds: [full.id], awaitSessionListHydration: true,
        request: async path => path === '/v2/sessions/read-batch' ? (bodyReads++, Response.json({ results: [{ sessionId: full.id,
            detail: { status: 200, body: { session: full } } }] }))
            : Response.json({ sessions: [{ ...scalars, documents: 'omitted', metadataAudience: 'owner', agentStateDocument: 'omitted' }] }),
        getExistingSession, getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    expect(bodyReads).toBe(0);
    expect(storage.getState().sessions[full.id]?.metadata?.name).toBe('Exact reader label');
});

it('batches missing ordinary display documents even when no full Session hydration is demanded', async () => {
    const serverId = 'cold-ordinary-home';
    const full = { id: 'cold-ordinary', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: 'plain' as const, metadataLayoutVersion: 0, metadataVersion: 1, agentStateVersion: 0,
        metadata: JSON.stringify({ path: '/cold', host: 'home', name: 'Cold ordinary label' }),
        agentState: null, dataEncryptionKey: null, share: null };
    const { metadata: _metadata, agentState: _agentState, ...scalars } = full;
    const body = V2SessionListResponseSchema.parse({ sessions: [{ ...scalars, documents: 'omitted',
        metadataAudience: 'owner', agentStateDocument: 'omitted' }] });
    let bodyReads = 0;
    await fetchAndApplySessions({ serverId, credentials: { token: 'cold-ordinary-account' },
        accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(), encryption: null, sessionDataKeys: new Map(),
        request: async (path) => path === '/v2/sessions/read-batch' ? (bodyReads++, Response.json({ results: [{ sessionId: full.id,
            detail: { status: 200, body: { session: full } } }] })) : Response.json(body),
        sessionListBackgroundHydrationMaxRows: 0,
        getExistingSession: () => null,
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    expect(bodyReads).toBe(1);
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[full.id]?.metadata?.name).toBe('Cold ordinary label');
    expect(storage.getState().sessions[full.id]).toBeUndefined();
});

it('withdraws retained owner display at the real store when a compact row changes key', () => {
    const serverId = 'compact-audience-home';
    const previous = buildSessionListRenderableFromSession({ ...createSessionFixture({ id: 'audience-row',
        metadata: { path: '/owner-private', host: 'private-host', name: 'Owner private title' }, metadataVersion: 1,
        metadataLayoutVersion: 0, agentStateVersion: 1 }),
        [SESSION_LIST_DOCUMENT_ADMISSION]: { scope: 'scope', encryptionMode: 'e2ee', metadataLayoutVersion: 0,
            dataEncryptionKey: 'owner-key', metadataAudience: 'owner' } });
    storage.getState().applyServerScopedSessionListRows(serverId, [previous], { source: 'rowOnly', mode: 'replace' });
    const row = { id: previous.id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'e2ee' as const, metadataLayoutVersion: 0, metadataVersion: 1, agentStateVersion: 1,
        dataEncryptionKey: null, documents: 'omitted' as const, metadataAudience: 'owner' as const,
        agentStateDocument: 'omitted' as const, share: null };
    const admittedRow = V2SessionListResponseSchema.parse({ sessions: [row] }).sessions[0]!;
    const next = buildRenderableFromRowAndCache(admittedRow, { token: 'same-account' }, undefined, undefined, null, previous, 'scope');
    storage.getState().applyServerScopedSessionListRows(serverId, [next], { source: 'rowOnly', mode: 'replace' });
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[previous.id]?.metadata).toBeNull();
});

it('does not admit an unscoped persisted display as current content or full-document readiness', async () => {
    const serverId = 'persisted-compact-home';
    const row = { id: 'persisted-display', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        archivedAt: null, encryptionMode: 'plain' as const, metadataLayoutVersion: 0, metadataVersion: 1,
        agentStateVersion: 10, dataEncryptionKey: null, share: null, documents: 'omitted', metadataAudience: 'owner',
        agentStateDocument: 'omitted', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 };
    const cache = { sessionId: row.id, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, archivedAt: null,
        metadataVersion: 1, agentStateVersion: 1, metadataLayoutVersion: 0, encryptionMode: 'plain' as const,
        encryptedContentAvailability: 'ready' as const, path: '/persisted', name: 'Persisted name',
        dataEncryptionKey: null, metadataAudience: 'owner' as const };
    let reads = 0;
    await fetchAndApplySessions({ serverId, credentials: { token: 'persisted-account' },
        accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(), encryption: null, sessionDataKeys: new Map(),
        contentDemand: 'list-projection', activeSessionIds: [row.id], cachedSessionListEntries: { [row.id]: cache },
        request: async (path) => { if (path === '/v2/sessions/read-batch') reads += 1;
            return path === '/v2/sessions/read-batch' ? Response.json({ results: [{ sessionId: row.id,
                detail: { status: 503, body: { error: 'unavailable' } } }] })
                : Response.json({ sessions: [row], nextCursor: null, hasNext: false }); },
        getExistingSession: () => null,
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: rows => storage.getState().applySessions(rows), log: { log() {} },
    });
    expect(reads).toBe(1);
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[row.id]?.metadata).toBeNull();
    expect(storage.getState().sessions[row.id]).toBeUndefined();
});

it('reuses 1000 admitted warm displays and batches only changed document demand without replacing full documents', async () => {
    const serverId = 'compact-home';
    const rows = Array.from({ length: 1000 }, (_, index) => ({
        id: `compact-${index}`, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        archivedAt: null, encryptionMode: 'plain' as const, metadataLayoutVersion: 0,
        metadata: JSON.stringify({ path: `/compact/${index}`, host: 'home', name: `Session ${index}` }),
        metadataVersion: 1, agentState: null as string | null, agentStateVersion: 0, dataEncryptionKey: null,
        share: null, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    }));
    const batches: string[][] = [];
    const refresh = (listProjection = false) => fetchAndApplySessions({
        serverId, credentials: { token: 'compact-account' }, accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(),
        encryption: null, sessionDataKeys: new Map(), sessionListPageSize: 200, sessionListMaxPages: 5,
        requiredHydrationSessionIds: listProjection ? undefined : rows.map(row => row.id), awaitSessionListHydration: true,
        ...(listProjection ? { contentDemand: 'list-projection' as const } : {}),
        request: async (path, init) => {
            if (path === '/v2/sessions/read-batch') {
                const input = JSON.parse(String(init.body));
                expect(input).toMatchObject({ includeSnapshot: true, includeTurns: false, includeMessages: false });
                batches.push(input.sessionIds);
                return Response.json({ results: input.sessionIds.map((sessionId: string) => ({ sessionId,
                    detail: { status: 200, body: { session: rows.find(row => row.id === sessionId) } } })) });
            }
            const offset = Number(new URL(path, 'https://home.invalid').searchParams.get('cursor') ?? 0);
            return Response.json({ sessions: rows.slice(offset, offset + 200).map(({ metadata, agentState, ...row }) => ({
                ...row, documents: 'omitted', metadataAudience: 'owner', agentStateDocument: 'omitted',
            })), nextCursor: offset + 200 < rows.length ? String(offset + 200) : null, hasNext: offset + 200 < rows.length });
        },
        getExistingSession: id => storage.getState().sessions[id],
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
        cachedSessionListEntries: buildSessionListCacheEntriesFromRenderables(storage.getState().sessionListRowsByServerId[serverId] ?? {}),
        applySessionListRenderables: values => storage.getState().applyServerScopedSessionListRows(serverId, values, { source: 'rowOnly', mode: 'replace' }),
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
        applySessions: values => storage.getState().applySessions(values), log: { log() {} },
    });
    await refresh();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1000);
    const opened = storage.getState().sessions['compact-0']!;
    expect(opened.metadata?.name).toBe('Session 0');
    batches.length = 0;
    await refresh();
    expect(batches).toEqual([]);
    expect(storage.getState().sessions['compact-0']?.metadata).toBe(opened.metadata);
    rows[0] = { ...rows[0]!, metadataVersion: 2, metadata: JSON.stringify({ path: '/compact/0', host: 'home', name: 'Renamed session' }) };
    await refresh();
    expect(batches).toEqual([['compact-0']]);
    expect(storage.getState().sessions['compact-0']?.metadata?.name).toBe('Renamed session');
    expect(storage.getState().sessions['compact-1']?.metadataVersion).toBe(1);
    batches.length = 0;
    rows[1] = { ...rows[1]!, agentStateVersion: 2 };
    await refresh(true);
    expect(batches).toEqual([]);
    expect(storage.getState().sessions['compact-1']?.agentStateVersion).toBe(0);
    expect(storage.getState().sessionListRowsByServerId[serverId]?.['compact-1']?.agentStateVersion).toBe(0);
    rows[1] = { ...rows[1]!, agentStateVersion: 3, pendingPermissionRequestCount: 1,
        agentState: JSON.stringify({ requests: { approve: { tool: 'Bash', kind: 'permission',
            arguments: { command: 'git status' }, createdAt: 2 } } }) };
    rows[2] = { ...rows[2]!, agentStateVersion: 1, pendingPermissionRequestCount: 1 };
    await refresh(true);
    expect(batches).toEqual([['compact-1', 'compact-2']]);
    expect(storage.getState().sessionListRowsByServerId[serverId]?.['compact-2']?.hasPendingPermissionRequests).toBe(true);
    expect(storage.getState().sessions['compact-1']?.agentStateVersion).toBe(0);
    batches.length = 0;
    await refresh(true);
    expect(batches).toEqual([]);
});
