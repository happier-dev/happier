import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createCompactSessionListRowFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary(() => ({ ok: true }));
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { getServerProfileById, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { createSessionRouteServerScope } = await import('./sessionRouteServerScope');
const { useHydrateSessionForRoute } = await import('./useHydrateSessionForRoute');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let serverId: string;
let alias: string;
let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHydrateSessionForRoute>>>> | undefined;
beforeEach(async () => {
    await homes.reset();
    const localId = await homes.addHome({ name: 'Session route Home', serverUrl: 'https://session-route.test', accountId: 'account' });
    const identified = await setServerProfileIdentityForUrl('https://session-route.test', 'srv_session_route');
    expect(identified).not.toBeNull();
    alias = localId;
    const request = createSessionReadBatchFetchBoundary(homes.request);
    connection = await restoreServerAccountForTest({ serverUrl: 'https://session-route.test',
        serverIdentityId: 'srv_session_route', accountId: 'account', request });
    installHomeGovernanceBoundaries(homes);
    setRuntimeFetch(request);
    serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
    expect(getServerProfileById(alias)?.id).toBe(connection.home.id);
    expect(resolveServerProfileScopeIdForIdentifier(alias)).toBe(serverId);
    installSessionActionFixture({ homes, storage, serverId: localId,
        session: { id: 'own-session', serverId, encryptionMode: 'plain', metadata: { path: '/repo', host: 'test' } } });
});
afterEach(async () => { await hook?.unmount(); hook = undefined; await connection?.dispose(); });

describe('Session route Home alias resolution', () => {
    it('resolves a local-profile alias to the canonical Home before real route hydration', async () => {
        const canonical = createSessionRouteServerScope({ id: 'own-session', serverId });
        const aliased = createSessionRouteServerScope({ id: 'own-session', serverId: alias });
        expect(aliased.serverId).toBe(canonical.serverId);
        expect(aliased.buildHref('own-session')).toBe(canonical.buildHref('own-session'));
        hook = await renderHook(() => useHydrateSessionForRoute('own-session', 'alias-route', aliased.hydrationOptions));
        expect(hook.getCurrent()).toMatchObject({ kind: 'available', sessionId: 'own-session', serverId });
        await act(async () => storage.setState(state => ({ sessions: { ...state.sessions } })));
        expect(hook.getCurrent().kind).toBe('available');
        const foreign = createSessionRouteServerScope({ id: 'own-session', serverId: 'foreign-home' });
        expect(foreign.serverId).toBe('foreign-home');
        expect(foreign.hydrationOptions).toEqual({ serverId: 'foreign-home' });
    });

    it('hydrates a cold alias-qualified Session through the same Home HTTP authority', async () => {
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, sessionListIndexByServerId: {} });
        const scope = createSessionRouteServerScope({ id: 'own-session', serverId: alias });
        hook = await renderHook(() => useHydrateSessionForRoute('own-session', 'cold-alias-route', {
            ...scope.hydrationOptions, hydrateMessages: false,
        }));
        await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ kind: 'available', sessionId: 'own-session', serverId }));
        expect(storage.getState().sessions['own-session']?.serverId).toBe(serverId);
        const reads = homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v2/sessions/own-session');
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(request => request.serverUrl === 'https://session-route.test')).toBe(true);
    });
});

describe('Session route full-document readiness', () => {
    it.each(['withdrawn-turns', 'content-becomes-readable'] as const)(
        'satisfies visible turn demand when route metadata stays available (%s)', async mode => {
            const projection = { v: 1 as const, sessionId: 'own-session', updatedAt: 10,
                latestTurnId: 'changed-turn', turns: [{ turnId: 'changed-turn', initiator: 'user' as const,
                    status: 'completed' as const, startedAt: 1, updatedAt: 10,
                    automationLifecycleFacts: { launchProfileId: null, changedFiles: true },
                    transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 2 } }] };
            const ready = installSessionActionFixture({ homes, storage, serverId,
                session: { ...storage.getState().sessions['own-session']!, sessionTurns: projection } });
            if (mode === 'content-becomes-readable') storage.getState().applySessions([{ ...ready,
                metadata: null, encryptedContentAvailability: 'encrypted_content_unavailable', sessionTurns: undefined }]);
            const turnReads = () => homes.requests.filter(request =>
                new URL(request.path, request.serverUrl).pathname === '/v1/sessions/own-session/turns').length;
            hook = await renderHook(() => useHydrateSessionForRoute('own-session', 'visible-turn-demand', {
                serverId, hydrateMessages: false, includeTurnsProjection: true,
            }));
            expect(hook.getCurrent().kind).toBe('available');
            expect(turnReads()).toBe(0);

            await act(async () => storage.getState().applySessions([{ ...ready, sessionTurns: undefined }]));

            await vi.waitFor(() => expect(storage.getState().sessions['own-session']?.sessionTurns).toEqual(projection));
            expect(hook.getCurrent().kind).toBe('available');
            expect(turnReads()).toBe(1);
        });

    it.each(['failed-state', 'stale-full', 'pending-display', 'changed-key', 'persisted-display', 'current-full'] as const)(
        'acquires full route documents without promoting a partial display (%s)', async mode => {
            await connection.dispose();
            const { Encryption } = await import('@/sync/encryption/encryption');
            const { encodeBase64 } = await import('@/encryption/base64');
            const { deriveAccountSigningPublicKey } = await import('@/auth/flows/challenge');
            const { sync } = await import('@/sync/sync');
            const { fetchAndApplySessionById } = await import('@/sync/engine/sessions/sessionById');
            const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
            const { buildSessionListCacheEntriesFromRenderables } = await import('@/sync/domains/state/warmCacheAdapters');
            const { SessionListCacheEntryV1Schema } = await import('@/sync/domains/state/warmCachePersistence');
            const secret = new Uint8Array(32).fill(71);
            const key = new Uint8Array(32).fill(72);
            const id = `route-documents-${mode}`;
            const accountId = 'route-documents-account';
            const credentials = { token: createAccountTokenForTests(accountId), secret: encodeBase64(secret) };
            const writer = await Encryption.create(secret);
            writer.configureNativeCryptoWorker({ routing: { mode: 'off' } });
            const accountCurrentness = { ...createPlainAccountEncryptionCurrentnessFixture(), mode: 'e2ee' as const,
                signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(secret)),
                contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(writer.contentDataKey),
                recipientEnvelopeReadiness: { status: 'available' as const } };
            const homeId = await homes.addHome({ name: 'Route document Home', serverUrl: 'https://route-documents.test',
                accountId, accountEncryptionMode: 'e2ee', credentials });
            homes.answer(homeId, '/v1/account/encryption/currentness', { body: accountCurrentness });
            homes.answer(homeId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
            homes.answer(homeId, '/v2/sessions/active', { body: { sessions: [], nextCursor: null, hasNext: false } });
            const request = createSessionReadBatchFetchBoundary(homes.request);
            connection = await restoreServerAccountForTest({ serverUrl: 'https://route-documents.test', accountId, credentials, request });
            serverId = resolveServerProfileScopeIdForIdentifier(connection.serverId);
            installHomeGovernanceBoundaries(homes);
            setRuntimeFetch(request);
            const encryption = sync.encryption;
            expect(encryption).not.toBeNull();
            if (!encryption) throw new Error('The encrypted Account did not establish its runtime');
            encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
            await writer.initializeSessions(new Map([[id, key]]), { serverId });
            const cipher = writer.getSessionEncryption(id)!;
            const oldState = { requests: { retained: { tool: 'Bash', arguments: { command: 'git status' }, createdAt: 1 } } };
            const { ownerMetadata: _ownerMetadata, ...legacy } = createPlainSessionCurrentProjectionRecordFixture({ id });
            const full = { ...legacy, encryptionMode: 'e2ee' as const, metadataLayoutVersion: 0,
                metadataVersion: 1, agentStateVersion: 1,
                metadata: await cipher.encryptRaw({ path: '/route-documents', host: 'home', name: 'Original metadata' }),
                agentState: await cipher.encryptRaw(oldState), dataEncryptionKey: encodeBase64(await writer.encryptEncryptionKey(key)),
                pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 };
            const getExistingSession = (sessionId: string) => storage.getState().sessions[sessionId];
            const getCurrentSessionListRenderable = (sessionId: string) => storage.getState().sessionListRowsByServerId[serverId]?.[sessionId];
            const applySessions = (rows: Parameters<ReturnType<typeof storage.getState>['applySessions']>[0]) => storage.getState().applySessions(rows);
            const sessionDataKeys = new Map<string, Uint8Array>();
            const initial = await fetchAndApplySessionById({ serverId, sessionId: id, credentials, accountCurrentness, encryption,
                sessionDataKeys, includeTurnsProjection: false, prefetched: { detail: { status: 200, body: { session: full } } },
                request: async () => { throw new Error('Unexpected prefetched fixture transport'); }, getExistingSession,
                applySessions, log: { log() {} } });
            expect(initial.ok).toBe(true);
            const retainedState = getExistingSession(id)!.agentState;
            let fresh = { ...full, metadataVersion: 2, agentStateVersion: mode === 'failed-state' || mode === 'stale-full' ? 2 : 1,
                metadata: await cipher.encryptRaw({ path: '/route-documents', host: 'home', name: 'Fresh metadata' }) };
            if (mode === 'changed-key') {
                const replacementKey = new Uint8Array(32).fill(74);
                const replacement = await writer.openEncryption(replacementKey);
                fresh = { ...full, dataEncryptionKey: encodeBase64(await writer.encryptEncryptionKey(replacementKey)),
                    metadata: encodeBase64((await replacement.encrypt([{ path: '/route-documents', host: 'home', name: 'Original metadata' }]))[0]!),
                    agentState: encodeBase64((await replacement.encrypt([oldState]))[0]!) };
            }
            const exactGate = createDeferred<void>();
            const displayGate = createDeferred<void>();
            const displayStarted = createDeferred<void>();
            let pendingDisplay: Promise<unknown> | undefined;
            const refresh = (row: typeof fresh, contentDemand?: 'list-projection', cachedSessionListEntries?: Parameters<typeof fetchAndApplySessions>[0]['cachedSessionListEntries']) =>
                fetchAndApplySessions({ serverId, credentials, accountCurrentness, encryption, sessionDataKeys,
                    contentDemand, cachedSessionListEntries,
                    ...(contentDemand ? {} : { requiredHydrationSessionIds: [id], awaitSessionListHydration: true }),
                    request: async path => {
                        if (path !== '/v2/sessions/read-batch') return Response.json({ sessions: [createCompactSessionListRowFixture(row)] });
                        displayStarted.resolve();
                        if (mode === 'pending-display' || mode === 'changed-key') await displayGate.promise;
                        return Response.json({ results: [{ sessionId: id, detail: { status: 200, body: { session: row } } }] });
                    },
                    getExistingSession, getCurrentSessionListRenderable,
                    applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'rowOnly', mode: 'replace' }),
                    applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
                    applySessions, log: { log() {} } });
            try {
                if (mode === 'failed-state' || mode === 'stale-full') {
                    const wrongCipher = await writer.openEncryption(new Uint8Array(32).fill(73));
                    await refresh({ ...fresh, agentState: encodeBase64((await wrongCipher.encrypt([{}]))[0]!) });
                    expect(getExistingSession(id)?.metadata?.name).toBe('Fresh metadata');
                    expect(getExistingSession(id)?.agentState).toBe(retainedState);
                    expect(getExistingSession(id)?.agentStateVersion).toBe(1);
                } else if (mode === 'pending-display' || mode === 'changed-key') {
                    pendingDisplay = refresh(fresh, 'list-projection');
                    await displayStarted.promise;
                    expect(getExistingSession(id)?.metadataVersion).toBe(1);
                    expect(getCurrentSessionListRenderable(id)?.metadataVersion).toBe(mode === 'changed-key' ? 0 : 1);
                } else if (mode === 'persisted-display') {
                    const cached = SessionListCacheEntryV1Schema.parse(JSON.parse(JSON.stringify(
                        buildSessionListCacheEntriesFromRenderables({ [id]: getCurrentSessionListRenderable(id)! })[id],
                    )));
                    await act(async () => storage.setState({ sessions: {} }));
                    await refresh(full, 'list-projection', { [id]: cached });
                    expect(getExistingSession(id)).toBeUndefined();
                    expect(getCurrentSessionListRenderable(id)?.metadata?.name).toBe('Original metadata');
                }
                const recovered = mode === 'failed-state' || mode === 'stale-full'
                    ? { ...fresh, agentState: await cipher.encryptRaw({ requests: {} }) }
                    : mode === 'current-full' || mode === 'persisted-display' ? full : fresh;
                homes.answer(homeId, `/v2/sessions/${id}`, { body: { session: mode === 'stale-full' ? full : recovered }, respondAfter: exactGate.promise });
                const exactReads = () => homes.requests.filter(value => new URL(value.path, value.serverUrl).pathname === `/v2/sessions/${id}`).length;
                const readsBeforeMount = exactReads();
                hook = await renderHook(() => useHydrateSessionForRoute(id, 'route-document-readiness', {
                    serverId, hydrateMessages: false, includeTurnsProjection: false,
                }));
                if (mode === 'current-full') {
                    expect(hook.getCurrent()).toMatchObject({ kind: 'available', sessionId: id });
                    expect(exactReads()).toBe(readsBeforeMount);
                } else {
                    await vi.waitFor(() => expect(exactReads()).toBe(readsBeforeMount + 1));
                    expect(hook.getCurrent().kind).toBe('loading');
                    await act(async () => exactGate.resolve());
                    if (mode === 'stale-full') {
                        await vi.waitFor(() => expect(hook!.getCurrent().kind).toBe('retrying'));
                        expect(getExistingSession(id)?.metadataVersion).toBe(2);
                        expect(getExistingSession(id)?.agentState).toBe(retainedState);
                        expect(getExistingSession(id)?.agentStateVersion).toBe(1);
                        homes.answer(homeId, `/v2/sessions/${id}`, { body: { session: recovered } });
                        const retried = await sync.ensureSessionVisibleForMessageRoute(id, {
                            serverId, forceRefresh: true, hydrateMessages: false, includeTurnsProjection: false,
                        });
                        expect(retried.kind).toBe('available');
                    }
                    await vi.waitFor(() => expect(hook!.getCurrent()).toMatchObject({ kind: 'available', sessionId: id }));
                    expect(getExistingSession(id)?.metadataVersion).toBe(recovered.metadataVersion);
                    expect(getExistingSession(id)?.agentStateVersion).toBe(recovered.agentStateVersion);
                    expect(exactReads()).toBe(readsBeforeMount + (mode === 'stale-full' ? 2 : 1));
                }
            } finally {
                exactGate.resolve();
                displayGate.resolve();
                await pendingDisplay;
            }
        },
    );
});
