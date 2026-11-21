import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { CurrentCursorResponseSchema} from '@happier-dev/protocol/changes';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, standardCleanup } from '@/dev/testkit';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage, readSessionOrganizationProjectionCached } from '@/sync/domains/state/storage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { saveSessionListWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { fetchAndApplySessionOrganizationSnapshot } from '@/sync/ops/sessionOrganization/fetchSessionOrganizationSnapshot';
import { createCompactSessionListRowFixture, createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

// Real Account restoration, Sync, HTTP schemas, store and rail projection; only
// the network transport and native platform adapters are substituted.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(socket => { configureConnectedServerSocketBoundary(socket); });

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

describe('ordinary Session refresh hydrates every personal pin surface', () => {
    beforeAll(loadSyncSingletonForTests);
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
    });

    it('reads the ordinary list while a warm Home’s first organization snapshot is pending', async () => {
        const serverId = 'srv_warm_pin_refresh';
        const accountId = 'warm-pin-refresh';
        const organization = createDeferred<void>();
        const requestPaths = new Set<string>();
        const sessionId = 'retained-ordinary-session';
        await prepareWarmCacheEncryptionKey();
        saveSessionListWarmCacheEntries(serverId, accountId, {
            [sessionId]: {
                sessionId, name: 'Retained Session', path: '/repo',
                metadataVersion: 1, agentStateVersion: 0, updatedAt: 2, createdAt: 1,
                active: false, activeAt: 2, archivedAt: null,
            },
        });
        try {
            connection = await restoreServerAccountForTest({
                serverUrl: 'https://warm-pin-refresh.example.test', serverIdentityId: serverId, accountId,
                request: async (input, init) => {
                    const path = new URL(String(input)).pathname;
                    requestPaths.add(path);
                    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                    if (path === '/v1/account/profile') return Response.json({ id: accountId });
                    if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                    if (path === '/v2/session-organization') await organization.promise;
                    return createEmptyAccountBootstrapHttpResponse(path, init);
                },
            });
            expect(storage.getState().sessionListRowsByServerId[serverId]?.[sessionId]?.metadata?.name)
                .toBe('Retained Session');
            await vi.waitFor(() => expect(requestPaths.has('/v2/session-organization')).toBe(true));
            await vi.waitFor(() => expect(requestPaths.has('/v2/sessions/active')).toBe(true));
            expect(storage.getState().sessionOrganizationSnapshotVersionByServerId[serverId]).toBeUndefined();
        } finally {
            organization.resolve();
        }
        const { sync } = await import('@/sync/sync');
        await sync.refreshSessions();
        expect(storage.getState().sessionOrganizationSnapshotVersionByServerId[serverId]).toBe(0);
    });

    it.each(['retained', 'new', 'new-listed', 'unlisted-batch-unavailable', 'batched', 'batched-reloaded', 'overtaken', 'list-only-newer', 'reloaded', 'reloaded-unavailable', 'reloaded-unrecognized', 'reloaded-removed', 'phone-pinned'] as const)('hydrates %s pinned Bots alongside list and dual-surface pins', async membership => {
        const pins = [
            { sessionId: 'list-only', sortKey: 'a', pinnedAt: 1, listPinned: true, railPinned: false },
            { sessionId: 'rail-only', sortKey: 'b', pinnedAt: 2, listPinned: false, railPinned: true },
            { sessionId: 'both', sortKey: 'c', pinnedAt: 3, listPinned: true, railPinned: true },
            ...(membership.startsWith('batched') ? Array.from({ length: 24 }, (_, index) => ({
                sessionId: `bulk-${index}`, sortKey: `d${String(index).padStart(2, '0')}`,
                pinnedAt: index + 4, listPinned: true, railPinned: false,
            })) : []),
        ];
        const snapshot = SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
            schemaVersion: 1, version: 1, pins, folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        } });
        const emptySnapshot = SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
            ...snapshot.snapshot, version: 0, pins: [],
        } });
        let pinsAvailable = membership !== 'new' && membership !== 'new-listed';
        let serveNewerRow = false;
        let staleSnapshotAvailable = false;
        const sourceMetadata = { path: '/bot', host: 'fixture', bot: { kind: 'bot' } };
        const owner = createSessionOwnerMetadataV1({ metadata: sourceMetadata });
        if (!owner.ok) throw new Error('Bot owner metadata fixture was rejected');
        const metadata = projectSessionSharedMetadataV1({ metadata: sourceMetadata });
        const records = new Map(pins.map(pin => [pin.sessionId, SessionCurrentProjectionRecordV1Schema.parse({
            id: pin.sessionId, seq: 0, createdAt: 1, updatedAt: 2, active: false, activeAt: 1,
            archivedAt: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: JSON.stringify(metadata), metadataVersion: 1, agentState: null, agentStateVersion: 0,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        })]));
        // A Bot kept on the phone bar is a device-local pin (owner 11-06, lab mnBots A): no organization pin.
        if (membership === 'phone-pinned') records.set('phone-bot', SessionCurrentProjectionRecordV1Schema.parse({ ...records.get('rail-only'), id: 'phone-bot' }));
        const exactReads: string[] = [];
        const ordinaryRecord = SessionCurrentProjectionRecordV1Schema.parse({ ...records.get('list-only'), id: 'ordinary' });
        const nextPageRecord = SessionCurrentProjectionRecordV1Schema.parse({ ...ordinaryRecord, id: 'next-page' });
        const physicalBatches: string[][] = [];
        let ordinaryListReads = 0;
        let fullReadsAvailable = membership !== 'new-listed' && membership !== 'unlisted-batch-unavailable';
        const readSession = (path: string, method: string, body?: unknown): Response | undefined => {
            const sessionId = path.startsWith('/v2/sessions/') ? decodeURIComponent(path.slice('/v2/sessions/'.length)) : '';
            const record = records.get(sessionId);
            if (!record) return undefined;
            const returnNewerRow = serveNewerRow || (membership === 'batched-reloaded'
                && staleSnapshotAvailable && physicalBatches.length > 1);
            const current = returnNewerRow
                ? { ...record, seq: 14, updatedAt: 3, metadataVersion: Math.max(2, record.metadataVersion) }
                : record;
            if (method === 'PATCH') {
                const patch = SessionMetadataTuplePatchV1Schema.parse(body);
                if (patch.mode !== 'owner' || !patch.displayProjectionV1) throw new Error('Expected owner display maintenance');
                if (patch.sharedMetadata.expectedVersion !== current.metadataVersion
                    || patch.agentState.expectedVersion !== current.agentStateVersion
                    || JSON.stringify(patch.expectedOwnerMetadata) !== JSON.stringify(current.ownerMetadata)) {
                    return Response.json({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                        sharedMetadata: { version: current.metadataVersion }, agentState: { version: current.agentStateVersion } }, { status: 409 });
                }
                expect(patch).toMatchObject({ sharedMetadata: { ciphertext: current.metadata },
                    ownerMetadata: current.ownerMetadata, agentState: { ciphertext: current.agentState } });
                expect(patch.displayProjectionV1).toMatchObject({ metadataLayoutVersion: 1,
                    sourceMetadataVersion: current.metadataVersion + 1 });
                const committed = SessionCurrentProjectionRecordV1Schema.parse({ ...current,
                    metadata: patch.sharedMetadata.ciphertext, metadataVersion: current.metadataVersion + 1,
                    ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext,
                    displayProjectionV1: patch.displayProjectionV1 });
                records.set(sessionId, committed);
                return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: committed.metadataVersion }, agentState: { version: committed.agentStateVersion } }));
            }
            if (method !== 'GET') return undefined;
            exactReads.push(sessionId);
            if (!fullReadsAvailable) return Response.json({ error: 'unavailable' }, { status: 503 });
            if (membership === 'reloaded-unavailable' && staleSnapshotAvailable && sessionId === 'rail-only') {
                return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            if (membership === 'reloaded-removed' && staleSnapshotAvailable && sessionId === 'rail-only') {
                return Response.json(V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }), { status: 404 });
            }
            if (membership === 'reloaded-unrecognized' && staleSnapshotAvailable && sessionId === 'rail-only') {
                return Response.json({ error: 'proxy_route_missing' }, { status: 404 });
            }
            return Response.json({ session: current });
        };
        const sessionBoundary = createSessionReadBatchHttpBoundary(request => readSession(request.path, request.method, request.body));
        connection = await restoreServerAccountForTest({
            serverUrl: `https://${membership}-rail-hydration.example.test`,
            serverIdentityId: `srv_rail-hydration-${membership}`, accountId: 'rail-account',
            request: async (url, init) => {
                const target = new URL(String(url));
                const path = target.pathname;
                if (path === '/v2/sessions/read-batch') {
                    physicalBatches.push(JSON.parse(String(init?.body)).sessionIds);
                    if (membership === 'unlisted-batch-unavailable' && !fullReadsAvailable) {
                        return Response.json({ error: 'unavailable' }, { status: 503 });
                    }
                    return await sessionBoundary.handle({
                    home: membership, accountId: 'rail-account', url: target, path, method: init?.method ?? 'GET',
                    headers: new Headers(init?.headers), signal: init?.signal,
                    body: init?.body ? JSON.parse(String(init.body)) : undefined,
                    }) ?? null;
                }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }));
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }));
                if (path === '/v2/session-organization') return Response.json(pinsAvailable ? snapshot : emptySnapshot);
                if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
                if (path === '/v2/sessions') ordinaryListReads += 1;
                if (membership === 'new-listed' && path === '/v2/sessions') return Response.json({
                    sessions: target.searchParams.has('cursor')
                        ? [nextPageRecord]
                        : [ordinaryRecord, ...[...records.values()].map(createCompactSessionListRowFixture)],
                    nextCursor: target.searchParams.has('cursor') ? null : 'next-page',
                    hasNext: !target.searchParams.has('cursor'),
                });
                if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({
                    sessions: membership === 'new-listed'
                        ? [...records.values()].map(createCompactSessionListRowFixture)
                        : membership === 'batched-reloaded' && staleSnapshotAvailable
                            ? [...records.values()].map(createCompactSessionListRowFixture)
                        : staleSnapshotAvailable ? [records.get('rail-only')] : [],
                    nextCursor: null, hasNext: false,
                });
                return readSession(path, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : undefined) ?? null;
            },
        });
        const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
        await fetchAndApplySessionOrganizationSnapshot({ credentials: connection.credentials, serverId, serverUrl: connection.home.serverUrl });
        if (membership === 'phone-pinned') storage.setState(state => ({ localSettings: { ...state.localSettings,
            navigationSurfacePlacementsV1: { phoneLauncher: { orderedIds: [], placements: { [`bot:${serverId}:phone-bot`]: 'pinned' } } } } }));
        // External Agent mutations arrive through the refresh, after the app
        // already has a last-known organization snapshot.
        pinsAvailable = true;
        const { sync } = await import('./sync');
        if (membership === 'unlisted-batch-unavailable') {
            await expect(sync.refreshSessions({ awaitSessionListHydration: true })).resolves.toBeDefined();
            expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('ready');
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            fullReadsAvailable = true;
            await sync.refreshSessions({ awaitSessionListHydration: true });
            for (const pin of pins) expect(storage.getState().sessions[pin.sessionId]).toMatchObject({ id: pin.sessionId });
            return;
        }
        if (membership === 'new-listed') {
            await expect(sync.refreshSessions({ awaitSessionListHydration: true })).resolves.toBeDefined();
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            expect(storage.getState().sessionListRowsByServerId[serverId].ordinary).toMatchObject({ id: 'ordinary' });
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ metadataUnavailable: true });
            expect(sync.readOrdinarySessionListFrontier()).toMatchObject({ nextCursor: 'next-page', hasNext: true });
            await sync.fetchMoreSessions();
            expect(storage.getState().sessionListRowsByServerId[serverId]['next-page']).toMatchObject({ id: 'next-page' });
            expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('ready');
            fullReadsAvailable = true;
            await sync.refreshSessions({ awaitSessionListHydration: true });
            for (const pin of pins) expect(storage.getState().sessions[pin.sessionId]).toMatchObject({ id: pin.sessionId });
            return;
        }
        if (membership === 'batched') {
            await sync.refreshSessions();
            storage.setState({ sessions: {} });
            physicalBatches.length = 0;
            const ordinaryReadsBeforeHydration = ordinaryListReads;
            await sync.refreshSessions({ awaitSessionListHydration: true });
            // Bootstrap's public queue can run another snapshot concurrently;
            // each gathered missing-row demand still owns one physical batch.
            expect(physicalBatches.length).toBeGreaterThan(0);
            expect(physicalBatches.length).toBeLessThanOrEqual(ordinaryListReads - ordinaryReadsBeforeHydration);
            for (const batch of physicalBatches) expect(new Set(batch)).toEqual(new Set(pins.map(pin => pin.sessionId)));
            for (const pin of pins) expect(storage.getState().sessions[pin.sessionId]).toMatchObject({ id: pin.sessionId });
            return;
        }
        if (membership === 'batched-reloaded') {
            await sync.refreshSessions();
            storage.getState().applyServerScopedSessionListRowPatches(serverId, pins.map(pin => ({
                sessionId: pin.sessionId, patch: { seq: 14, updatedAt: 3, metadataVersion: 2 },
            })));
            storage.setState({ sessions: {} });
            staleSnapshotAvailable = true;
            physicalBatches.length = 0;
            const ordinaryReadsBeforeHydration = ordinaryListReads;
            await sync.refreshSessions({ awaitSessionListHydration: true });
            // A stale full read is followed by one gathered repair, even when
            // required demand exceeds the existing per-row work concurrency.
            expect(physicalBatches.length).toBeGreaterThan(1);
            expect(physicalBatches.length).toBeLessThanOrEqual(2 * (ordinaryListReads - ordinaryReadsBeforeHydration));
            for (const batch of physicalBatches) expect(new Set(batch)).toEqual(new Set(pins.map(pin => pin.sessionId)));
            for (const pin of pins) expect(storage.getState().sessions[pin.sessionId]).toMatchObject({
                id: pin.sessionId, seq: 14, metadataVersion: 2,
            });
            return;
        }
        // Join bootstrap's public queue before arranging the later live read.
        await sync.refreshSessions();
        if (membership === 'overtaken') {
            // A live detail read has already hydrated a newer revision than
            // the exact-id row returned by this list refresh.
            serveNewerRow = true;
            await sync.ensureSessionVisibleForMessageRoute('rail-only', { forceRefresh: true, hydrateMessages: false });
            expect(storage.getState().sessions['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            serveNewerRow = false;
        }
        if (membership === 'reloaded' || membership === 'reloaded-unavailable' || membership === 'reloaded-unrecognized' || membership === 'reloaded-removed') {
            await sync.refreshSessions({ awaitSessionListHydration: true });
            // Navigation opens newer tuple data. A reload keeps the warm list
            // projection but retires the opened Session entity.
            serveNewerRow = true;
            await sync.ensureSessionVisibleForMessageRoute('rail-only', { forceRefresh: true, hydrateMessages: false });
            expect(storage.getState().sessions['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            const { ['rail-only']: _railSession, ...sessions } = storage.getState().sessions;
            storage.setState({ sessions });
            staleSnapshotAvailable = true;
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
        }
        staleSnapshotAvailable = staleSnapshotAvailable || membership === 'overtaken' || membership === 'list-only-newer';
        if (membership === 'reloaded-unavailable' || membership === 'reloaded-unrecognized') {
            await expect(sync.refreshSessions({ awaitSessionListHydration: true })).resolves.toBeDefined();
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            return;
        }
        if (membership === 'list-only-newer') {
            // A newer list projection without the opened Session entity cannot
            // be promoted to successful required hydration.
            const { ['rail-only']: _railSession, ...sessions } = storage.getState().sessions;
            storage.setState({ sessions });
            storage.getState().applyServerScopedSessionListRowPatches(serverId, [{
                sessionId: 'rail-only', patch: { seq: 14, updatedAt: 3, metadataVersion: 2 },
            }]);
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            await expect(sync.refreshSessions({ awaitSessionListHydration: true })).resolves.toBeDefined();
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            return;
        }
        await sync.refreshSessions({ awaitSessionListHydration: true });

        if (membership === 'reloaded-removed') {
            expect(storage.getState().sessions['rail-only']).toBeUndefined();
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toBeUndefined();
            return;
        }

        expect(new Set(exactReads)).toEqual(new Set(['list-only', 'rail-only', 'both', ...(membership === 'phone-pinned' ? ['phone-bot'] : [])]));
        if (membership === 'phone-pinned') expect(storage.getState().sessions['phone-bot']).toMatchObject({ id: 'phone-bot' });
        const organization = readSessionOrganizationProjectionCached(storage.getState(), serverId);
        expect(organization.pinnedSessionIds).toEqual(['list-only', 'both']);
        expect(organization.railPinnedSessionIds).toEqual(['rail-only', 'both']);
        const { buildAppRailEntries } = await import('@/components/navigation/shell/appRail/appRailModel');
        const entries = buildAppRailEntries([], { botHomes: [{ serverId, organization,
            rowsBySessionId: storage.getState().sessionListRowsByServerId[serverId] ?? {} }] });
        expect(entries.bots.map(entry => entry.sessionId)).toEqual(['rail-only', 'both']);
        if (membership === 'overtaken' || membership === 'reloaded') {
            expect(storage.getState().sessions['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
            expect(storage.getState().sessionListRowsByServerId[serverId]['rail-only']).toMatchObject({ seq: 14, metadataVersion: 2 });
        }
        if (membership === 'retained') {
            const address = { serverId, sessionId: 'rail-only' };
            const { retainVisibleSessionListSurfaces } = await import('./domains/session/sessionSurfaceVisibility');
            const release = retainVisibleSessionListSurfaces([address]);
            try {
                // The exact read establishes this Home's ordinary hydration;
                // returning to a visible row must not force another witness.
                await sync.ensureSessionVisibleForMessageRoute(address.sessionId, {
                    serverId, forceRefresh: true, hydrateMessages: false,
                });
                const countRailReads = () => exactReads.filter(id => id === address.sessionId).length;
                const readsAfterHydration = countRailReads();
                await sync.hydrateSessionListRows([address]);
                expect(countRailReads()).toBe(readsAfterHydration);
                // A newer canonical tuple still demands a read; a retained
                // opened row is not a cache that can overrule list invalidation.
                serveNewerRow = true;
                storage.getState().applyServerScopedSessionListRowPatches(serverId, [{
                    sessionId: address.sessionId, patch: { seq: 14, updatedAt: 3, metadataVersion: 2 },
                }]);
                await sync.hydrateSessionListRows([address]);
                expect(countRailReads()).toBe(readsAfterHydration + 1);
                expect(storage.getState().sessions[address.sessionId]).toMatchObject({ seq: 14, metadataVersion: 2 });
                await sync.hydrateSessionListRows([address]);
                expect(countRailReads()).toBe(readsAfterHydration + 1);
                // Mutation/disclosure callers' explicit exact witness is kept.
                await sync.ensureSessionVisibleForMessageRoute(address.sessionId, {
                    serverId, forceRefresh: true, hydrateMessages: false,
                });
                expect(countRailReads()).toBe(readsAfterHydration + 2);
            } finally { release(); }
        }
    });
});
