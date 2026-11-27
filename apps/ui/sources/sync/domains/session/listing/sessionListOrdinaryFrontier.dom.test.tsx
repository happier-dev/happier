/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { AccountSettingsV2GetResponseSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { V2SessionListResponseSchema} from '@happier-dev/protocol/sessions/control/contract';
import { type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';

import {
    createPlainSessionCurrentProjectionRecordFixture,
    createSessionFixture,
    createSessionOwnerViewerFixture,
} from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { createCompactSessionListFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { readSessionFullPublicationUpdatedAt } from '@/sync/domains/session/sessionRuntimeObservation';
import { sync } from '@/sync/sync';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import {
    readConcurrentOrdinarySessionListLifecycle,
    startConcurrentSessionCacheSync,
    stopConcurrentSessionCacheSync,
} from '@/sync/runtime/orchestration/concurrentSessionCache';
import { resolveOrdinarySessionListHomeOwner } from './sessionListQueryRuntime';
import {
    ActivityPersonalSessionMembershipProvider,
    useActivityPersonalSessionMembership,
    type ActivityPersonalSessionMembership,
} from '@/activity/source/activityPersonalSessionMembership';
import { buildSessionListQueryKey } from './sessionListQueryKey';
import { resolveSessionListQueryPresentation } from './sessionListIndexPresentation';
import {
    type SessionListQueryHomeInput,
    type SessionListQuerySourceState,
    useSessionListQuerySourceState,
} from './useSessionListQuerySourceState';

const QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: false, scope: 'my_work',
    attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: true,
};
const ORDINARY_ADAPTER = { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' } as const;
const HOME_A_URL = 'https://ordinary-frontier-a.test';
const HOME_B_URL = 'https://ordinary-frontier-b.test';
const HOME_C_URL = 'https://ordinary-frontier-c.test';
const features = createRootLayoutFeaturesResponse({ features: {
    sessions: { enabled: true, filteredListing: { enabled: false } },
    workflows: { enabled: false }, automations: { enabled: false },
    social: { friends: { enabled: false } },
    encryption: { plaintextStorage: { enabled: true } },
} });
const requests: Array<Readonly<{ origin: string; cursor: string | null }>> = [];
const personalQueryRequests: Array<string | null> = [];
let filteredListingEnabled = false;
let ordinaryFailure: 'http' | 'invalid' | 'network' | null = null;
let secondaryHeadRevision = 1;
const socketsByOrigin = new Map<string, Socket>();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let homes: Awaited<ReturnType<typeof upsertServerProfile>>[] = [];
let secondaryCredentialWrites: HomeCredentialWriteRollback[] = [];
let secondaryPageThreeGate: Promise<void> | null = null;
let releaseSecondaryPageThree: (() => void) | null = null;
let markSecondaryPageThreeStarted: (() => void) | null = null;
const sessionActiveAt = Date.now();

function ordinarySessionRow(origin: string, page: number) {
    const revision = origin === HOME_B_URL && page === 1 ? secondaryHeadRevision : 1;
    const session = createSessionFixture({ id: 'session-page-' + page, active: true, activeAt: sessionActiveAt,
        updatedAt: revision, metadataVersion: revision });
    if (!session.metadata) throw new Error('Session fixture must carry metadata');
    return { ...createPlainSessionCurrentProjectionRecordFixture({
        id: session.id, active: session.active, activeAt: session.activeAt, updatedAt: session.updatedAt,
        metadataVersion: revision, metadata: { ...session.metadata, name: `Session page ${page} revision ${revision}` },
    }), viewer: createSessionOwnerViewerFixture(session) };
}

async function respond(url: Parameters<typeof fetch>[0], init?: RequestInit) {
    const target = new URL(String(url));
    if (target.pathname === '/v2/sessions/read-batch') return null;
    if (![HOME_A_URL, HOME_B_URL, HOME_C_URL].includes(target.origin)) throw new Error('Unexpected listing Home');
    if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
    if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return Response.json({
        ...features, features: { ...features.features, sessions: {
            ...features.features.sessions, filteredListing: { enabled: filteredListingEnabled },
        } },
    });
    if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
    if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
    if (target.pathname === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
        content: { t: 'plain', v: {} }, version: 1,
    }));
    if (target.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
    if (target.pathname === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
        snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [],
            folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
    }));
    if (target.pathname === '/v1/machines') return Response.json([]);
    if (target.pathname === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({
        sessions: [], nextCursor: null, hasNext: false,
        attentionNextCursor: null, attentionHasNext: false,
    }));
    if (target.pathname === '/v2/sessions/query') {
        const query = JSON.parse(String(init?.body)) as { cursor?: string };
        personalQueryRequests.push(query.cursor ?? null);
        const page = query.cursor === undefined ? 1 : 2;
        const session = createSessionFixture({ id: 'personal-page-' + page, active: true, activeAt: Date.now() });
        return Response.json({
            sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({
                id: session.id, active: session.active, activeAt: session.activeAt,
            }), viewer: createSessionOwnerViewerFixture(session) }],
            nextCursor: page === 1 ? 'personal-page-2' : null, hasNext: page === 1,
            attentionNextCursor: null, attentionHasNext: false,
        });
    }
    const exactSession = /^\/v2\/sessions\/session-page-([1-3])$/.exec(target.pathname);
    if (exactSession) return Response.json({ session: ordinarySessionRow(target.origin, Number(exactSession[1])) });
    if (target.pathname !== '/v2/sessions') return new Response('{}', { status: 404 });
    const cursor = target.searchParams.get('cursor');
    requests.push({ origin: target.origin, cursor });
    if (target.origin === HOME_A_URL) {
        if (ordinaryFailure === 'http') return Response.json({ error: 'list_failed' }, { status: 500 });
        if (ordinaryFailure === 'invalid') return Response.json({ sessions: [{ id: 'broken', metadataLayoutVersion: 1 }], nextCursor: null, hasNext: false });
        if (ordinaryFailure === 'network') throw new TypeError('Failed to fetch');
    }
    const page = cursor === null ? 1 : cursor === 'page-2' ? 2 : cursor === 'page-3' ? 3 : null;
    if (page === null) throw new Error('Unexpected ordinary-list cursor');
    if (target.origin === HOME_B_URL && page === 3) {
        markSecondaryPageThreeStarted?.();
        await secondaryPageThreeGate;
    }
    return Response.json({
        sessions: [ordinarySessionRow(target.origin, page)],
        nextCursor: page === 3 ? null : 'page-' + (page + 1),
        hasNext: page < 3,
        attentionNextCursor: null,
        attentionHasNext: false,
    });
}

function requestsFor(origin: string) {
    return requests.filter((request) => request.origin === origin).map((request) => request.cursor);
}

async function renderSource(inputs: SessionListQueryHomeInput[]) {
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let sourceState: SessionListQuerySourceState | null = null;
    function Harness() {
        sourceState = useSessionListQuerySourceState({ enabled: true, homes: inputs });
        return null;
    }
    await act(async () => { root.render(<Harness />); });
    return {
        read: () => sourceState,
        async settle(serverId: string) {
            await act(async () => {
                await vi.waitFor(() => expect(sourceState?.statesByServerId[serverId]).toBeDefined());
            });
        },
        async dispose() {
            await act(async () => { root.unmount(); });
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        },
    };
}

describe('ordinary Session-list frontier on the Home Sync owns', () => {
    beforeAll(async () => {
        vi.stubGlobal('__DEV__', true);
        vi.stubGlobal('self', globalThis);
        await initializeRealAppRuntimeForTests();
    });
    beforeEach(async () => {
        storage.setState(storage.getInitialState(), true);
        requests.length = 0;
        personalQueryRequests.length = 0;
        filteredListingEnabled = false;
        ordinaryFailure = null;
        secondaryHeadRevision = 1;
        socketsByOrigin.clear();
        secondaryPageThreeGate = null;
        releaseSecondaryPageThree = null;
        markSecondaryPageThreeStarted = null;
        const connected = new Promise<void>((resolve) => {
            installDisconnectedServerSocketBoundary((socket, serverUrl) => {
                if (serverUrl) socketsByOrigin.set(new URL(serverUrl).origin, socket);
                // Replace only the remote connection event. ApiSocket and Sync
                // must publish readiness through the real SDK listeners.
                vi.spyOn(socket, 'connect').mockImplementation(() => {
                    socket.connected = true;
                    for (const listener of socket.listeners('connect')) listener();
                    resolve();
                    return socket;
                });
            });
        });
        connection = await restoreServerAccountForTest({ serverUrl: HOME_A_URL, accountId: 'ordinary-account', request: respond });
        await connected;
        expect(storage.getState().socketStatus).toBe('connected');
        homes = [
            connection.home,
            await upsertServerProfile({ serverUrl: HOME_B_URL }),
            await upsertServerProfile({ serverUrl: HOME_C_URL }),
        ];
        for (const home of homes.slice(1)) {
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(
                home.serverUrl, { serverId: home.id }, connection.credentials,
            );
            if (!write) throw new Error('Could not save the secondary test Home Account');
            secondaryCredentialWrites.push(write);
        }
        const request = createCompactSessionListFetchBoundary(async (path, init) => await respond(path, init) ?? undefined);
        setRuntimeFetch(request);
        await Promise.all(homes.map((home) => getServerFeaturesSnapshot({ serverId: home.id, force: true })));
        await updateEffectiveHomeViewState((current) => ({
            ...current, groups: [], activeTargetKind: 'server', activeTargetId: homes[0]!.id,
        }), { scope: 'device' });
    });
    afterEach(async () => {
        releaseSecondaryPageThree?.();
        stopConcurrentSessionCacheSync();
        await connection?.dispose();
        for (const write of secondaryCredentialWrites) await write.rollback();
        secondaryCredentialWrites = [];
        for (const home of homes) await removeServerProfile(home.id);
        homes = [];
        connection = null;
        storage.setState(storage.getInitialState(), true);
        vi.restoreAllMocks();
    });

    it('reads Sync\'s frontier instead of opening a second paginator over the same corpus', async () => {
        const serverId = homes[0]!.id;
        await sync.refreshSessions({ awaitSessionListHydration: true });
        await sync.fetchMoreSessions();
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['session-page-1', 'session-page-2']);
        expect(sync.readOrdinarySessionListLifecycle().frontier.nextCursor).toBe('page-3');
        expect(resolveOrdinarySessionListHomeOwner(serverId)).toBe('sync');
        const beforeMount = requestsFor(HOME_A_URL);
        const harness = await renderSource([{ serverId, query: QUERY, ordinaryAdapter: ORDINARY_ADAPTER }]);
        try {
            await harness.settle(serverId);
            expect(requestsFor(HOME_A_URL)).toEqual(beforeMount);
            expect(harness.read()?.statesByServerId[serverId]).toMatchObject({
                phase: 'ready', nextCursor: 'page-3', appliedSourceKind: 'ordinary',
                addresses: [{ serverId, sessionId: 'session-page-1' }, { serverId, sessionId: 'session-page-2' }],
            });
            await act(async () => { await harness.read()?.loadNext(); });
            expect(requestsFor(HOME_A_URL)).toEqual([...beforeMount, 'page-3']);
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-1', 'session-page-2', 'session-page-3']);
            await act(async () => { await harness.read()?.refresh(); });
            expect(requestsFor(HOME_A_URL)).toEqual([...beforeMount, 'page-3', null]);
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-1']);
        } finally { await harness.dispose(); }
    });

    it('publishes active ordinary failures through Sync to the mounted source and shared Retry presentation', async () => {
        const serverId = homes[0]!.id;
        await sync.refreshSessions({ awaitSessionListHydration: true });
        const harness = await renderSource([{ serverId, query: QUERY, ordinaryAdapter: ORDINARY_ADAPTER }]);
        try {
            await harness.settle(serverId);
            for (const failure of ['http', 'invalid'] as const) {
                ordinaryFailure = failure;
                const before = requestsFor(HOME_A_URL).length;
                await act(async () => { await expect(sync.refreshSessions({ awaitSessionListHydration: true })).rejects.toBeDefined(); });
                expect(requestsFor(HOME_A_URL).length - before).toBe(1);
                const state = harness.read()?.statesByServerId[serverId];
                expect(state).toMatchObject({ phase: 'error', failureReason: 'response' });
                expect(resolveSessionListQueryPresentation({ selectedServerIds: [serverId], statesByServerId: { [serverId]: state },
                    coverageComplete: false, retainedRowCount: 1, settlingHomeServerId: serverId,
                })).toEqual({ kind: 'error', retainedRows: true });
            }
            ordinaryFailure = null;
            await act(async () => { await sync.refreshSessions({ awaitSessionListHydration: true }); });
            expect(harness.read()?.statesByServerId[serverId]).toMatchObject({ phase: 'ready', failureReason: null, failureCode: null });
            // A failed list fetch does not withdraw a connected socket whose
            // Home readiness probes still succeed.
            ordinaryFailure = 'network';
            await act(async () => { await expect(sync.refreshSessions({ awaitSessionListHydration: true })).rejects.toBeDefined(); });
            const failed = harness.read()?.statesByServerId[serverId];
            expect(failed).toMatchObject({ phase: 'error', failureReason: 'network' });
            expect(resolveSessionListQueryPresentation({ selectedServerIds: [serverId], statesByServerId: { [serverId]: failed },
                coverageComplete: false, retainedRowCount: 1,
            })).toEqual({ kind: 'error', retainedRows: true });
        } finally { await harness.dispose(); }
    });

    it('keeps background Activity membership partial without draining unseen personal-list pages', async () => {
        filteredListingEnabled = true;
        await getServerFeaturesSnapshot({
            serverId: homes[0]!.id,
            force: true,
        });
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const membership: { current: ActivityPersonalSessionMembership | null } = { current: null };
        function Observer() {
            membership.current = useActivityPersonalSessionMembership();
            return null;
        }
        try {
            await act(async () => root.render(
                <ActivityPersonalSessionMembershipProvider enabled>
                    <Observer />
                </ActivityPersonalSessionMembershipProvider>,
            ));
            const serverId = homes[0]!.id;
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(membership.current?.statesByServerId[serverId]).toMatchObject({
                    phase: 'ready', failureReason: null, failureCode: null,
                });
            });
            expect(personalQueryRequests).toEqual([null]);
            expect(membership.current?.membershipByServerId[serverId]).toEqual(['personal-page-1']);
            expect(membership.current?.coverageComplete).toBe(false);
            expect(storage.getState().sessionListRowsByServerId[serverId]?.['personal-page-2']).toBeUndefined();
        } finally {
            await act(async () => root.unmount());
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });

    it('pages a managed secondary Home only on demand through its incumbent frontier', async () => {
        const serverId = homes[1]!.id;
        // Hold the final HTTP response to exercise concurrent demands through the
        // real transport, owner, membership publication and mounted source.
        secondaryPageThreeGate = new Promise<void>((resolve) => { releaseSecondaryPageThree = resolve; });
        const pageThreeStarted = new Promise<void>((resolve) => { markSecondaryPageThreeStarted = resolve; });
        await updateEffectiveHomeViewState((current) => ({ ...current,
            activeTargetKind: 'group', activeTargetId: 'ordinary-homes',
            groups: [{ id: 'ordinary-homes', name: 'Ordinary Homes',
                serverIds: [homes[0]!.id, serverId], presentation: 'grouped' }],
        }), { scope: 'device' });
        startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(readConcurrentOrdinarySessionListLifecycle(serverId)).toMatchObject({
            hasFetchedSnapshot: true, fetchInFlight: false, fetchMoreInFlight: false,
        }));
        // Cross the owner's 600 ms continuation debounce. With no viewport or
        // explicit operation asking for more, the first page must remain alone.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect(requestsFor(HOME_B_URL)).toEqual([null]);
        expect(readConcurrentOrdinarySessionListLifecycle(serverId).frontier.nextCursor).toBe('page-2');
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['session-page-1']);
        expect(resolveOrdinarySessionListHomeOwner(serverId)).toBe('concurrent');
        const beforeMount = requestsFor(HOME_B_URL);
        const harness = await renderSource([{ serverId, query: QUERY, ordinaryAdapter: ORDINARY_ADAPTER }]);
        try {
            await harness.settle(serverId);
            expect(requestsFor(HOME_B_URL)).toEqual(beforeMount);
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-1']);
            expect(harness.read()?.statesByServerId[serverId]).toMatchObject({ phase: 'ready', nextCursor: 'page-2' });
            expect(harness.read()?.coverageComplete).toBe(false);
            await act(async () => { await harness.read()?.loadNext(); });
            expect(requestsFor(HOME_B_URL)).toEqual([null, 'page-2']);
            expect(harness.read()?.statesByServerId[serverId]).toMatchObject({ phase: 'ready', nextCursor: 'page-3' });
            // A remote content update refreshes the already-visible head. It
            // must keep both the acquired second page and the next demand cursor.
            secondaryHeadRevision = 2;
            const secondarySocket = socketsByOrigin.get(HOME_B_URL);
            expect(secondarySocket).toBeDefined();
            await act(async () => {
                for (const listener of secondarySocket!.listeners('update')) {
                    listener({ id: 'ordinary-head-updated', seq: 2, createdAt: 2,
                        body: { t: 'update-session', id: 'session-page-1' } });
                }
                await vi.waitFor(() => {
                    // The compact list advertises the changed metadata version;
                    // its full read must publish the updated head.
                    const head = storage.getState().sessionListRowsByServerId[serverId]?.['session-page-1'];
                    expect(head).toBeDefined();
                    expect(head?.metadataVersion).toBe(2);
                    expect(readSessionFullPublicationUpdatedAt(head!)).toBe(2);
                    expect(readConcurrentOrdinarySessionListLifecycle(serverId).fetchMoreInFlight).toBe(false);
                });
            });
            expect(requestsFor(HOME_B_URL)).toEqual([null, 'page-2', null]);
            expect(harness.read()?.statesByServerId[serverId]?.nextCursor).toBe('page-3');
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-1', 'session-page-2']);
            await act(async () => {
                const acquisition = harness.read()?.loadNext();
                await pageThreeStarted;
                const sameAcquisition = harness.read()?.loadNext();
                releaseSecondaryPageThree?.();
                await Promise.all([acquisition, sameAcquisition]);
            });
            expect(requestsFor(HOME_B_URL)).toEqual([null, 'page-2', null, 'page-3']);
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-1', 'session-page-2', 'session-page-3']);
            const activeHomeRow = storage.getState().sessionListRowsByServerId[homes[0]!.id]?.['session-page-1'];
            expect(activeHomeRow).toBeDefined();
            await act(async () => {
                const deleted = UpdateContainerSchema.parse({
                    id: 'secondary-page-one-deleted', seq: 2, createdAt: 2,
                    body: { t: 'delete-session', sid: 'session-page-1' },
                });
                for (const listener of secondarySocket!.listeners('update')) listener(deleted);
            });
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-2', 'session-page-3']);
            expect(storage.getState().sessionListRowsByServerId[serverId]?.['session-page-1']).toBeUndefined();
            expect(storage.getState().sessionListRowsByServerId[homes[0]!.id]?.['session-page-1']).toBe(activeHomeRow);
        } finally { await harness.dispose(); }
    });

    it('retires a revoked direct share only from its validated secondary Home socket identity', async () => {
        const serverId = homes[1]!.id;
        await updateEffectiveHomeViewState((current) => ({ ...current,
            activeTargetKind: 'group', activeTargetId: 'ordinary-homes',
            groups: [{ id: 'ordinary-homes', name: 'Ordinary Homes',
                serverIds: [homes[0]!.id, serverId], presentation: 'grouped' }],
        }), { scope: 'device' });
        startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[serverId])
            .toEqual(['session-page-1']));
        const secondarySocket = socketsByOrigin.get(HOME_B_URL);
        expect(secondarySocket).toBeDefined();
        const activeHomeRow = storage.getState().sessionListRowsByServerId[homes[0]!.id]?.['session-page-1'];
        expect(activeHomeRow).toBeDefined();
        // A sharing-shaped object without the canonical envelope/required share
        // identity cannot authorize destructive local retirement.
        for (const listener of secondarySocket!.listeners('update')) {
            listener({ body: { t: 'session-share-revoked', sessionId: 'session-page-1' } });
        }
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['session-page-1']);
        const revoked = UpdateContainerSchema.parse({
            id: 'secondary-share-revoked', seq: 2, createdAt: 2,
            body: { t: 'session-share-revoked', sessionId: 'session-page-1', shareId: 'direct-share-1' },
        });
        for (const listener of secondarySocket!.listeners('update')) listener(revoked);
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual([]);
        expect(storage.getState().sessionListRowsByServerId[serverId]?.['session-page-1']).toBeUndefined();
        expect(storage.getState().sessionListRowsByServerId[homes[0]!.id]?.['session-page-1']).toBe(activeHomeRow);
    });

    it('moves a retained secondary row between ordinary and archived membership from validated socket updates', async () => {
        const serverId = homes[1]!.id;
        await updateEffectiveHomeViewState((current) => ({ ...current,
            activeTargetKind: 'group', activeTargetId: 'ordinary-homes',
            groups: [{ id: 'ordinary-homes', name: 'Ordinary Homes',
                serverIds: [homes[0]!.id, serverId], presentation: 'grouped' }],
        }), { scope: 'device' });
        startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[serverId])
            .toEqual(['session-page-1']));
        const secondarySocket = socketsByOrigin.get(HOME_B_URL);
        expect(secondarySocket).toBeDefined();
        const activeHomeRow = storage.getState().sessionListRowsByServerId[homes[0]!.id]?.['session-page-1'];
        expect(activeHomeRow).toBeDefined();
        const publish = (archivedAt: number | null, seq: number) => {
            const update = UpdateContainerSchema.parse({ id: 'archive-' + seq, seq, createdAt: seq,
                body: { t: 'update-session', id: 'session-page-1', archivedAt } });
            for (const listener of secondarySocket!.listeners('update')) listener(update);
        };
        publish(3, 3);
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual([]);
        expect(storage.getState().archivedSessionListMembershipByServerId[serverId]).toEqual(['session-page-1']);
        expect(storage.getState().sessionListRowsByServerId[serverId]?.['session-page-1']?.archivedAt).toBe(3);
        publish(null, 4);
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['session-page-1']);
        expect(storage.getState().archivedSessionListMembershipByServerId[serverId]).toEqual([]);
        expect(storage.getState().sessionListRowsByServerId[serverId]?.['session-page-1']?.archivedAt).toBeNull();
        expect(storage.getState().sessionListRowsByServerId[homes[0]!.id]?.['session-page-1']).toBe(activeHomeRow);
        expect(requestsFor(HOME_B_URL)).toEqual([null]);
    });

    it('keeps its own controller for a Home no incumbent ordinary owner manages', async () => {
        const serverId = homes[2]!.id;
        expect(resolveOrdinarySessionListHomeOwner(serverId)).toBeNull();
        const harness = await renderSource([{ serverId, query: QUERY, ordinaryAdapter: ORDINARY_ADAPTER }]);
        try {
            await harness.settle(serverId);
            expect(harness.read()?.statesByServerId[serverId]).toMatchObject({
                requestedQueryKey: buildSessionListQueryKey(serverId, QUERY),
                appliedQueryKey: null, phase: 'offline', addresses: [],
            });
            expect(harness.read()?.coverageComplete).toBe(false);
            await act(async () => { await harness.read()?.loadNext(); });
            expect(requestsFor(HOME_C_URL)).toEqual([]);
            expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toBeUndefined();
        } finally { await harness.dispose(); }
    });
});
