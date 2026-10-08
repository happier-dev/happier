/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema, V2SessionListResponseSchema, type SessionListQueryV1 } from '@happier-dev/protocol';

import { createPlainV2SessionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import {
    readConcurrentOrdinarySessionListLifecycle,
    startConcurrentSessionCacheSync,
    stopConcurrentSessionCacheSync,
} from '@/sync/runtime/orchestration/concurrentSessionCache';
import { resolveOrdinarySessionListHomeOwner } from './sessionListQueryRuntime';
import { buildSessionListQueryKey } from './sessionListQueryKey';
import {
    type SessionListQueryHomeInput,
    type SessionListQuerySourceState,
    useSessionListQuerySourceState,
} from './useSessionListQuerySourceState';

const QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: false, scope: 'my_work',
    attention: 'any', audiences: [], tagIds: [], includeAttention: true,
};
const ORDINARY_ADAPTER = { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' } as const;
const HOME_A_URL = 'https://ordinary-frontier-a.test';
const HOME_B_URL = 'https://ordinary-frontier-b.test';
const HOME_C_URL = 'https://ordinary-frontier-c.test';
const features = createRootLayoutFeaturesResponse({ features: {
    sessions: { filteredListing: { enabled: false } },
    workflows: { enabled: false }, automations: { enabled: false },
    social: { friends: { enabled: false } },
    encryption: { plaintextStorage: { enabled: true } },
} });
const requests: Array<Readonly<{ origin: string; cursor: string | null }>> = [];
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let homes: Awaited<ReturnType<typeof upsertServerProfile>>[] = [];
let secondaryCredentialWrites: HomeCredentialWriteRollback[] = [];
let secondaryPageThreeGate: Promise<void> | null = null;
let releaseSecondaryPageThree: (() => void) | null = null;
let markSecondaryPageThreeStarted: (() => void) | null = null;

async function respond(url: Parameters<typeof fetch>[0]) {
    const target = new URL(String(url));
    if (![HOME_A_URL, HOME_B_URL, HOME_C_URL].includes(target.origin)) throw new Error('Unexpected listing Home');
    if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
    if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return Response.json(features);
    if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
    if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
    if (target.pathname === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
        content: { t: 'plain', v: {} }, version: 1,
    }));
    if (target.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
    if (target.pathname === '/v1/machines') return Response.json([]);
    if (target.pathname === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({
        sessions: [], nextCursor: null, hasNext: false,
        attentionNextCursor: null, attentionHasNext: false,
    }));
    if (target.pathname !== '/v2/sessions') return new Response('{}', { status: 404 });
    const cursor = target.searchParams.get('cursor');
    requests.push({ origin: target.origin, cursor });
    const page = cursor === null ? 1 : cursor === 'page-2' ? 2 : cursor === 'page-3' ? 3 : null;
    if (page === null) throw new Error('Unexpected ordinary-list cursor');
    if (target.origin === HOME_B_URL && page === 3) {
        markSecondaryPageThreeStarted?.();
        await secondaryPageThreeGate;
    }
    return Response.json(V2SessionListResponseSchema.parse({
        sessions: [createPlainV2SessionRecordFixture({ id: 'session-page-' + page, active: true, activeAt: Date.now() })],
        nextCursor: page === 3 ? null : 'page-' + (page + 1),
        hasNext: page < 3,
        attentionNextCursor: null,
        attentionHasNext: false,
    }));
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
        secondaryPageThreeGate = null;
        releaseSecondaryPageThree = null;
        markSecondaryPageThreeStarted = null;
        const connected = new Promise<void>((resolve) => {
            installDisconnectedServerSocketBoundary((socket) => {
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
        setRuntimeFetch(respond);
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

    it('reads a managed secondary Home\'s incumbent frontier instead of truncating it to page one', async () => {
        const serverId = homes[1]!.id;
        // The concurrent owner eagerly continues its ordinary list. Hold the next
        // HTTP response, not its lifecycle, while the filter joins that acquisition.
        secondaryPageThreeGate = new Promise<void>((resolve) => { releaseSecondaryPageThree = resolve; });
        const pageThreeStarted = new Promise<void>((resolve) => { markSecondaryPageThreeStarted = resolve; });
        await updateEffectiveHomeViewState((current) => ({ ...current,
            activeTargetKind: 'group', activeTargetId: 'ordinary-homes',
            groups: [{ id: 'ordinary-homes', name: 'Ordinary Homes',
                serverIds: [homes[0]!.id, serverId], presentation: 'grouped' }],
        }), { scope: 'device' });
        startConcurrentSessionCacheSync();
        // Continuations are serialized by the real owner's debounce. Await the
        // transport event instead of imposing a shorter polling deadline.
        await pageThreeStarted;
        expect(requestsFor(HOME_B_URL)).toEqual([null, 'page-2', 'page-3']);
        expect(readConcurrentOrdinarySessionListLifecycle(serverId).frontier.nextCursor).toBe('page-3');
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['session-page-1', 'session-page-2']);
        expect(resolveOrdinarySessionListHomeOwner(serverId)).toBe('concurrent');
        const beforeMount = requestsFor(HOME_B_URL);
        const harness = await renderSource([{ serverId, query: QUERY, ordinaryAdapter: ORDINARY_ADAPTER }]);
        try {
            await harness.settle(serverId);
            expect(requestsFor(HOME_B_URL)).toEqual(beforeMount);
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-1', 'session-page-2']);
            expect(harness.read()?.statesByServerId[serverId]?.nextCursor).toBe('page-3');
            await act(async () => {
                const acquisition = harness.read()?.loadNext();
                releaseSecondaryPageThree?.();
                await acquisition;
            });
            expect(requestsFor(HOME_B_URL)).toEqual(beforeMount);
            expect(harness.read()?.statesByServerId[serverId]?.addresses.map((address) => address.sessionId))
                .toEqual(['session-page-1', 'session-page-2', 'session-page-3']);
        } finally { await harness.dispose(); }
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
