import { expect } from 'vitest';
import { act } from 'react';
import type { Socket } from 'socket.io-client';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';

import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import {
    createPlainSessionCurrentProjectionRecordFixture,
    createSessionFixture,
    createSessionOwnerViewerFixture,
} from '../fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from './homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from './realAppRuntimeHarness';
import {
    configureConnectedServerSocketBoundary,
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from './serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { readConcurrentOrdinarySessionListLifecycle, startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } from '@/sync/runtime/orchestration/concurrentSessionCache';
import { sync } from '@/sync/sync';

// This fixture owns app initialization; its callers time their query/lifecycle
// assertions after the real source graph and transport adapters are prepared.
await initializeRealAppRuntimeForTests();

type QueryRequest = Readonly<{
    serverId: string;
    cursor: string | null;
    signal: AbortSignal | null;
    aborts: { count: number };
}>;

/** Let each render commit before polling its projection, rather than holding an act scope open until that render. */
export function waitForSessionListQueryState<T>(assertion: () => T | Promise<T>): Promise<T> {
    return waitForHomeGovernance(async () => {
        await act(async () => {});
        return assertion();
    });
}

/** Real Home/Account, controller, store and Socket lifetimes; only network replies are synthetic. */
export async function createSessionListQuerySourceHarness() {
    await initializeRealAppRuntimeForTests();
    const previousState = storage.getState();
    storage.setState(storage.getInitialState(), true);
    const http = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(http);
    const sockets = new Map<string, Socket>();
    const events: Array<Readonly<{ kind: 'connected'; origin: string }> | Readonly<{ kind: 'query' | 'probe'; serverId: string }>> = [];
    const configureSocket = (socket: Socket, url?: string) => {
        if (url) sockets.set(new URL(url).origin, socket);
        if (url) socket.on('connect', () => { events.push({ kind: 'connected', origin: new URL(url).origin }); });
        configureConnectedServerSocketBoundary(socket);
    };
    installDisconnectedServerSocketBoundary(configureSocket);
    const queryRequests: QueryRequest[] = [];
    const rowIds = new Map<string, string[]>();
    const gates = new Map<string, Promise<void>>();
    const releases = new Map<string, () => void>();
    const failures = new Map<string, 'all' | 'nextPage'>();
    const unreachableHomes = new Set<string>();
    const accountIds = new Map<string, string>();
    const serverIds: string[] = [];
    const urls = ['https://query-source-a.test', 'https://query-source-b.test', 'https://query-source-c.test'];
    const setReachable = (serverId: string, reachable: boolean) => {
        if (reachable) unreachableHomes.delete(serverId);
        else unreachableHomes.add(serverId);
        for (const path of ['/health', '/v1/auth/ping']) {
            http.answer(serverId, path, { select() {
                events.push({ kind: 'probe', serverId });
                return { body: {}, status: reachable ? 200 : 503 };
            } });
        }
    };
    const setFeatures = (serverId: string, followingEnabled: boolean) => {
        const features = createRootLayoutFeaturesResponse({ features: {
            sessions: { enabled: true, filteredListing: { enabled: true }, following: { enabled: followingEnabled } },
            workflows: { enabled: false }, automations: { enabled: false },
            social: { friends: { enabled: false } }, encryption: { plaintextStorage: { enabled: true } },
        } });
        http.answer(serverId, '/v1/features', { body: features });
        http.answer(serverId, '/v1/features/authenticated', { body: features });
    };
    const page = (sessionIds: readonly string[], nextCursor: string | null) => ({
        sessions: sessionIds.map(id => {
            const session = createSessionFixture({ id, active: true, activeAt: Date.now() });
            return { ...createPlainSessionCurrentProjectionRecordFixture({
                id, active: session.active, activeAt: session.activeAt,
            }), viewer: createSessionOwnerViewerFixture(session) };
        }),
        nextCursor, hasNext: nextCursor !== null, attentionNextCursor: null, attentionHasNext: false,
    });
    for (const [index, serverUrl] of urls.entries()) {
        const accountId = `query-account-${index}`;
        const serverId = await http.addHome({ name: `Query Home ${index}`, serverUrl, accountId, active: false });
        serverIds.push(serverId);
        accountIds.set(serverId, accountId);
        setReachable(serverId, true);
        setFeatures(serverId, true);
        http.answer(serverId, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({
            content: { t: 'plain', v: {} }, version: 1,
        }) });
        http.answer(serverId, '/v2/session-organization', { body: SessionOrganizationSnapshotResponseSchema.parse({
            snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [],
                folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
        }) });
        http.answer(serverId, '/v1/machines', { body: [] });
        http.answer(serverId, '/v2/sessions', { body: page([], null) });
        http.answer(serverId, '/v2/sessions/active', { body: page([], null) });
        http.answer(serverId, '/v2/sessions/query', { select(input, request) {
            const cursor = input && typeof input === 'object' && 'cursor' in input && typeof input.cursor === 'string'
                ? input.cursor : null;
            const aborts = { count: 0 };
            const signal = request.signal ?? null;
            signal?.addEventListener('abort', () => { aborts.count += 1; }, { once: true });
            queryRequests.push({ serverId, cursor, signal, aborts });
            events.push({ kind: 'query', serverId });
            if (unreachableHomes.has(serverId)) return { dispatchThenFail: true };
            const failure = failures.get(serverId);
            if (failure === 'all' || (failure === 'nextPage' && cursor)) return { body: {}, status: 503, respondAfter: gates.get(serverId) };
            const currentAccountId = accountIds.get(serverId)!;
            return { body: page(cursor ? [`${currentAccountId}-page-2`] : rowIds.get(serverId) ?? [`${currentAccountId}-row`],
                cursor ? null : `cursor:${currentAccountId}`), respondAfter: gates.get(serverId) };
        } });
    }
    const connection = await restoreServerAccountForTest({
        serverUrl: urls[0]!, accountId: accountIds.get(serverIds[0]!)!,
        request: http.request, additionalRequestOrigins: urls.slice(1), configureSocket,
    });
    installHomeGovernanceBoundaries(http);
    await waitForHomeGovernance(() => expect(storage.getState().socketStatus).toBe('connected'));
    await http.selectHomes(serverIds);
    startConcurrentSessionCacheSync();
    await Promise.all(serverIds.map(serverId => getServerFeaturesSnapshot({ serverId, force: true })));
    await waitForHomeGovernance(() => {
        for (const url of urls) expect(sockets.get(url)?.connected).toBe(true);
    });
    await sync.refreshSessions({ awaitSessionListHydration: true });
    await waitForHomeGovernance(() => {
        for (const serverId of serverIds.slice(1)) {
            expect(readConcurrentOrdinarySessionListLifecycle(serverId)).toMatchObject({
                hasFetchedSnapshot: true, fetchInFlight: false, fetchMoreInFlight: false,
            });
        }
    });
    return {
        http,
        serverIds,
        queryRequests,
        events,
        origin(serverId: string) {
            const profile = getServerProfileById(serverId);
            if (!profile) throw new Error('Query Home is unavailable');
            return new URL(profile.serverUrl).origin;
        },
        accountId: (serverId: string) => accountIds.get(serverId)!,
        focusedHome: () => getActiveServerSnapshot().serverId,
        socket(serverId: string) {
            const profile = getServerProfileById(serverId);
            const socket = profile ? sockets.get(new URL(profile.serverUrl).origin) : undefined;
            if (!socket) throw new Error('Query Home has no transport');
            return socket;
        },
        setReachable,
        loseTransport(serverId: string) {
            const profile = getServerProfileById(serverId);
            const socket = profile ? sockets.get(new URL(profile.serverUrl).origin) : undefined;
            if (!socket) throw new Error('Query Home has no transport to lose');
            socket.connected = false;
            for (const listener of socket.listeners('disconnect')) listener('transport close');
        },
        setRows(serverId: string, sessionIds: string[]) { rowIds.set(serverId, sessionIds); },
        holdQueries(serverId: string) {
            gates.set(serverId, new Promise(resolve => { releases.set(serverId, resolve); }));
        },
        /** Answer the strict query with HTTP 503 (every page, or only pages after the first) until `null`. */
        failQueries(serverId: string, failing: 'all' | 'nextPage' | null) {
            if (failing === null) failures.delete(serverId);
            else failures.set(serverId, failing);
        },
        releaseQueries(serverId: string) {
            gates.delete(serverId);
            releases.get(serverId)?.();
            releases.delete(serverId);
        },
        async setFollowingEnabled(serverId: string, enabled: boolean) {
            setFeatures(serverId, enabled);
            await getServerFeaturesSnapshot({ serverId, force: true });
        },
        async switchAccount(serverId: string, accountId: string) {
            accountIds.set(serverId, accountId);
            await http.switchAccount(serverId, accountId);
        },
        async dispose() {
            for (const release of releases.values()) release();
            stopConcurrentSessionCacheSync();
            await connection.dispose();
            await http.reset();
            storage.setState(previousState, true);
        },
    };
}

export type SessionListQuerySourceHarness = Awaited<ReturnType<typeof createSessionListQuerySourceHarness>>;
