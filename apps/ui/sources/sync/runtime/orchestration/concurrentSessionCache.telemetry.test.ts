import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { act } from 'react-test-renderer';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    createDeferred,
    createPlainAccountEncryptionCurrentnessFixture,
    createSessionFixture,
    countStoreNotifications,
    registerStandardCleanupTarget,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import { createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
    projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    buildSessionMessageObservationFactsV1} from '@happier-dev/protocol/sessions';
import {
    type SessionListQueryV1} from '@happier-dev/protocol/sessions/listing/query';
import {
    type V2SessionRecord,
} from '@happier-dev/protocol/sessions/control/contract';
import * as cache from './concurrentSessionCache';
import { storage } from '@/sync/domains/state/storageStore';
import { useServerCredentialAccountScopes } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { disposeIrohHomeTunnelRuntime, getIrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/runtime';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { subscribeSessionListQueryHomeInvalidation } from '@/sync/domains/session/listing/sessionListQueryInvalidation';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createCompactSessionListFetchBoundary, createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { buildOrdinarySessionListHomeState } from '@/sync/domains/session/listing/ordinarySessionListHomeState';
import { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';

const secureStore = vi.hoisted(() => new Map<string, string>());
type TelemetrySocket = Socket & Readonly<{ dispatch: (event: string, payload: unknown) => void }>;
const socketState = vi.hoisted(() => ({
    byUrl: new Map<string, TelemetrySocket>(),
    failForToken: null as string | null,
}));
let restoreLocalStorage: (() => void) | null = null;

function compactFetch(request: RuntimeFetch, options?: Parameters<typeof createCompactSessionListFetchBoundary>[1]): RuntimeFetch {
    return createCompactSessionListFetchBoundary(async (path, init) =>
        new URL(path).pathname === '/v2/sessions/read-batch' ? undefined : request(path, init), options);
}

vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
    deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));

// The barrel reaches this same transport boundary through providerSettingsHarness.
// Keep one factory so later graph imports cannot replace the recorder or failures.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    if (socketState.failForToken && typeof socket.auth === 'object' && socket.auth.token === socketState.failForToken) {
        throw new Error('Socket transport construction failed');
    }
    socket.connect = vi.fn(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    const observed = Object.assign(socket, {
        dispatch(event: string, payload: unknown) {
            for (const listener of socket.listeners(event)) listener(payload);
        },
    });
    if (serverUrl) socketState.byUrl.set(serverUrl, observed);
});

function sessionRow(id: string, overrides: Partial<V2SessionRecord> = {}): V2SessionRecord {
    const session = createSessionFixture({ id });
    return {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        archivedAt: null, metadata: JSON.stringify(session.metadata), metadataVersion: 1,
        agentState: null, agentStateVersion: 1, dataEncryptionKey: null,
        encryptionMode: 'plain', share: null,
        effectiveAccess: {
            v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
        },
        ...overrides,
    };
}

function sessionPage(
    id: string,
    nextCursor: string | null,
    overrides: Partial<V2SessionRecord> = {},
): Response {
    const row = sessionRow(id, overrides);
    return Response.json({ sessions: [row], nextCursor, hasNext: nextCursor !== null });
}

afterEach(async () => {
    standardCleanup();
    cache.stopConcurrentSessionCacheSync();
    await disposeIrohHomeTunnelRuntime();
    restoreLocalStorage?.();
    restoreLocalStorage = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    secureStore.clear();
    socketState.byUrl.clear();
    socketState.failForToken = null;
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
    delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('concurrent session cache telemetry', () => {
    it('keeps a settled secondary Home free of polling reads and retires a pushed Session removal', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        restoreLocalStorage = installLocalStorageMock().restore;
        let reads = 0;
        vi.stubGlobal('fetch', compactFetch(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (path.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path.startsWith('/v2/sessions') || path === '/v1/machines') reads++;
            if (path === '/v1/machines') return Response.json([]);
            if (path === '/v2/sessions/active' || path === '/v2/sessions/attention') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v2/sessions') return sessionPage('idle-secondary', null);
            throw new Error(`Unexpected request: ${path}`);
        }));
        const bridge = await loadSyncSingletonForTests();
        registerStandardCleanupTarget({ unmount: bridge.dispose });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://idle-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://idle-b.example.test', name: 'Idle B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'idle-account-b' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({ version: 1,
            groups: [{ id: 'idle-group', name: 'Idle', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'idle-group' });
        vi.useFakeTimers();
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready'));
        await cache.refreshConcurrentMachineList(secondary.id);
        const before = reads;
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(reads - before).toBe(0);
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['idle-secondary']).toBeDefined();
        socketState.byUrl.get(secondary.serverUrl)!.dispatch('update', { id: 'idle-removal', seq: 2, createdAt: Date.now(),
            body: { t: 'delete-session', sid: 'idle-secondary' } });
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['idle-secondary']).toBeUndefined();
        expect(reads - before).toBe(0);
    });

    it('waits for a blocked head before continuing and coalesces demand during the continuation', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        restoreLocalStorage = installLocalStorageMock().restore;
        const secondaryOrigin = 'https://continuation-b.example.test';
        const headStarted = createDeferred<void>();
        const headGate = createDeferred<void>();
        const continuationStarted = createDeferred<void>();
        const continuationGate = createDeferred<void>();
        const cursors: Array<string | null> = [];
        const boundary = createCompactSessionListFetchBoundary(async path => {
            const url = new URL(path);
            if (url.pathname === '/v2/sessions/read-batch') return undefined;
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/machines') return Response.json([]);
            if (url.pathname === '/v2/sessions/active' || url.pathname === '/v2/sessions/attention') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') {
                if (url.origin !== secondaryOrigin) return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                const cursor = url.searchParams.get('cursor');
                cursors.push(cursor);
                if (cursor === 'second-page') {
                    continuationStarted.resolve();
                    await continuationGate.promise;
                    return sessionPage('continuation-second', 'third-page');
                }
                if (cursor === 'third-page') return sessionPage('continuation-third', null);
                headStarted.resolve();
                await headGate.promise;
                return sessionPage('continuation-head', 'second-page');
            }
            throw new Error(`Unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', vi.fn(boundary));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://continuation-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: secondaryOrigin, name: 'Continuation B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'continuation-account' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondaryOrigin, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'continuation-group', name: 'Continuation', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'continuation-group',
        });
        try {
            cache.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(cursors).toEqual([null]));
            await headStarted.promise;
            expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).fetchInFlight).toBe(true);
            let firstDemandSettled = false;
            const firstDemand = cache.loadNextConcurrentOrdinarySessionListPage(secondary.id).then(() => { firstDemandSettled = true; });
            // Let the public promise settle if it incorrectly drops the demand;
            // the external head response remains gated independently.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(firstDemandSettled).toBe(false);
            expect(cursors).toEqual([null]);
            headGate.resolve();
            await vi.waitFor(() => expect(cursors).toEqual([null, 'second-page']));
            await continuationStarted.promise;
            const secondDemand = cache.loadNextConcurrentOrdinarySessionListPage(secondary.id);
            const thirdDemand = cache.loadNextConcurrentOrdinarySessionListPage(secondary.id);
            continuationGate.resolve();
            await Promise.all([firstDemand, secondDemand, thirdDemand]);
            expect(cursors).toEqual([null, 'second-page']);
            expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
                .toEqual(['continuation-head', 'continuation-second']);
            expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier)
                .toMatchObject({ nextCursor: 'third-page', hasNext: true });
        } finally {
            headGate.resolve();
            continuationGate.resolve();
            cache.stopConcurrentSessionCacheSync();
        }
    });

    it('projects durable hints into only their Home row and targets unknown rows without reloading the list', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        restoreLocalStorage = installLocalStorageMock().restore;
        let listReads = 0;
        let exactReads = 0;
        const unknownRead = createDeferred<void>();
        const viewer = createSessionViewerFixture({ readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null } });
        const rows = [sessionRow('hint-0', { viewer })];
        vi.stubGlobal('fetch', vi.fn(createCompactSessionListFetchBoundary(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/v2/sessions/read-batch') return null;
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active' || url.pathname === '/v2/sessions/attention') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v1/machines') return Response.json([]);
            if (url.pathname === '/v2/sessions') {
                listReads += 1;
                return Response.json({ sessions: rows, nextCursor: null, hasNext: false });
            }
            if (url.pathname === '/v2/sessions/hint-unknown') {
                exactReads += 1;
                await unknownRead.promise;
                return Response.json({ session: sessionRow('hint-unknown', { seq: 12, updatedAt: 300 }) });
            }
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));
        const syncBridge = await loadSyncSingletonForTests();
        registerStandardCleanupTarget({ unmount: syncBridge.dispose });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://hints-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://hints-b.example.test', name: 'Hints B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'hints-account' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({ version: 1, groups: [{ id: 'hints', name: 'Hints', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'hints' });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready'), { timeout: 15_000 });
        await cache.refreshConcurrentMachineList(secondary.id);
        storage.getState().applyServerScopedSessionListRows(secondary.id, Array.from({ length: 999 }, (_, i) =>
            createSessionListRenderableSessionFixture({ id: `hint-${i + 1}`, lastViewedSessionSeq: 1 })), { source: 'ordinary', mode: 'append' });
        storage.getState().applyServerScopedSessionListRows(active.id, [createSessionListRenderableSessionFixture({ id: 'hint-0' })], { source: 'ordinary', mode: 'append' });
        const before = storage.getState().sessionListRowsByServerId;
        const readsBefore = listReads;
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({ enabled: true });
        syncPerformanceTelemetry.reset();
        const hint = (id: string, seq: number, createdAt: number) => ({
            id: `update-${seq}`, seq: 900, createdAt,
            body: { t: 'new-message', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1({
                id: `message-${seq}`, seq, localId: null, createdAt,
                content: { t: 'plain', v: { role: 'assistant', content: { type: 'text', text: 'not transferred' } } },
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }) },
        });
        const socket = socketState.byUrl.get(secondary.serverUrl)!;
        socket.dispatch('update', hint('hint-0', 9, 200));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]['hint-0']).toMatchObject({ seq: 9, updatedAt: 200, meaningfulActivityAt: 200, hasUnreadMessages: false, viewer });
        expect(storage.getState().sessionListRowsByServerId[secondary.id]['hint-999']).toBe(before[secondary.id]['hint-999']);
        expect(storage.getState().sessionListRowsByServerId[active.id]['hint-0']).toBe(before[active.id]['hint-0']);
        const revision = hint('hint-0', 9, 250);
        socket.dispatch('update', { ...revision, body: { ...revision.body, t: 'message-updated' } });
        expect(storage.getState().sessionListRowsByServerId[secondary.id]['hint-0']).toMatchObject({ seq: 9, updatedAt: 250 });
        const notifications = countStoreNotifications(storage);
        socket.dispatch('update', { ...revision, body: { ...revision.body, t: 'message-updated' } });
        expect(notifications.read()).toHaveLength(0);
        notifications.stop();
        const neutral = hint('hint-0', 10, 1_000);
        socket.dispatch('update', { ...neutral, body: { ...neutral.body, message: { ...neutral.body.message,
            attentionImpact: { affectsUnread: false, affectsMeaningfulActivity: false } } } });
        expect(storage.getState().sessionListRowsByServerId[secondary.id]['hint-0']).toMatchObject({ seq: 10, updatedAt: 1_000, meaningfulActivityAt: 250, hasUnreadMessages: false });
        socket.dispatch('update', hint('hint-1', 2, 200));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]['hint-1']).toMatchObject({ seq: 2, hasUnreadMessages: true });
        socket.dispatch('update', hint('hint-unknown', 12, 300));
        socket.dispatch('update', hint('hint-unknown', 12, 300));
        await vi.waitFor(() => expect(exactReads).toBe(1));
        unknownRead.resolve();
        await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[secondary.id]['hint-unknown']?.seq).toBe(12));
        expect(listReads).toBe(readsBefore);
        expect(exactReads).toBe(1);
        expect(syncPerformanceTelemetry.snapshot().events.find(event => event.name === 'sync.concurrent.refresh.socket')).toBeUndefined();
        expect(storage.getState().sessions['hint-unknown']).toBeUndefined();
    });

    it('carries ordinary HTTP and decode failures through observation to Retry while transport failures settle', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        restoreLocalStorage = installLocalStorageMock().restore;
        let reply: 'ready' | 'http' | 'invalid' | 'network' = 'ready';
        let listReads = 0;
        vi.stubGlobal('fetch', compactFetch(vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active' || url.pathname === '/v2/sessions/attention') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v1/machines') return Response.json([]);
            if (url.pathname === '/v2/sessions') {
                listReads += 1;
                if (reply === 'http') return Response.json({ error: 'list_failed' }, { status: 500 });
                if (reply === 'network') throw new TypeError('Failed to fetch');
                if (reply === 'invalid') return Response.json({ sessions: [{ id: 'broken', metadataLayoutVersion: 1 }], nextCursor: null, hasNext: false });
                return sessionPage('retained', null);
            }
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://failure-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://failure-b.example.test', name: 'Failure B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'failure-account' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({ version: 1, groups: [{ id: 'failures', name: 'Failures', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'failures' });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready'), { timeout: 15_000 });
        const ordinary = () => buildOrdinarySessionListHomeState({ serverId: secondary.id, requestedQueryKey: 'ordinary',
            sessionIds: storage.getState().ordinarySessionListMembershipByServerId[secondary.id] ?? [],
            observation: storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation,
            lifecycle: cache.readConcurrentOrdinarySessionListLifecycle(secondary.id),
            online: cache.getConcurrentSessionListQueryHomeAvailability(secondary.id) === 'online' ? true
                : cache.getConcurrentSessionListQueryHomeAvailability(secondary.id) === 'pending' ? null : false });
        const presentation = () => resolveSessionListQueryPresentation({ selectedServerIds: [secondary.id],
            statesByServerId: { [secondary.id]: ordinary() }, coverageComplete: false, retainedRowCount: 1,
            settlingHomeServerId: secondary.id });
        for (const failure of ['http', 'invalid'] as const) {
            reply = failure;
            const before = listReads;
            await cache.refreshConcurrentOrdinarySessionList(secondary.id);
            expect(listReads - before).toBe(1);
            expect(ordinary().failureReason).toBe('response');
            expect(presentation()).toEqual({ kind: 'error', retainedRows: true });
            expect(ordinary().addresses.map(address => address.sessionId)).toEqual(['retained']);
        }
        // Mis-binding a response to the network class must visibly change the composed result.
        const failed = ordinary();
        expect(resolveSessionListQueryPresentation({ selectedServerIds: [secondary.id],
            statesByServerId: { [secondary.id]: { ...failed, failureReason: 'network' } },
            coverageComplete: false, retainedRowCount: 1, settlingHomeServerId: secondary.id,
        })).toEqual({ kind: 'refreshing', retainedRows: true });
        reply = 'ready';
        await cache.refreshConcurrentOrdinarySessionList(secondary.id);
        expect(ordinary()).toMatchObject({ phase: 'ready', failureReason: null, failureCode: null });
        reply = 'network';
        await cache.refreshConcurrentOrdinarySessionList(secondary.id);
        // This Home's independent reachability probe still answers: the failed
        // list transport remains a network error while that Home settles.
        expect(ordinary()).toMatchObject({ phase: 'error', failureReason: 'network' });
        expect(presentation()).toEqual({ kind: 'refreshing', retainedRows: true });
    });

    it.each(['account-change', 'session-share-revoked'] as const)('does not sweep retained pages and retires withdrawn access through real %s ingress', async withdrawal => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        let accessWithdrawn = false;
        const exactReads: string[] = [];
        const cursors: Array<string | null> = [];
        const teamRow = sessionRow('team-withdrawn', {
            metadataLayoutVersion: 1,
            share: { accessLevel: 'view', canApprovePermissions: false },
            responsibleAccountId: null, responsibleAccount: null,
            metadata: JSON.stringify({ v: 1, summary: { text: 'Shared team Session', updatedAt: 1 } }),
            effectiveAccess: {
                v: 1, level: 'view', sources: [{ kind: 'team', teamId: 'withdrawal-team', requiredByTeamPolicy: false }],
                capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            },
        });
        const continuationPage = createSessionListSourceFixture({
            sessions: [teamRow, sessionRow('still-admitted'), sessionRow('temporarily-unavailable')],
            nextCursor: 'third-page', hasNext: true,
        });
        vi.stubGlobal('fetch', compactFetch(vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active' || url.pathname === '/v2/sessions/attention') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions/query') {
                return Response.json(createSessionListSourceFixture({
                    sessions: [{ ...teamRow, responsibleAccountId: null, responsibleAccount: null,
                        viewer: {
                            latestFailureSeq: null,
                            readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
                            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                            follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
                        } }],
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                }));
            }
            if (url.pathname === '/v2/sessions') {
                const cursor = url.searchParams.get('cursor');
                cursors.push(cursor);
                return cursor
                    ? Response.json(continuationPage)
                    : sessionPage('current-head', 'second-page');
            }
            if (url.pathname.startsWith('/v2/sessions/')) {
                const id = decodeURIComponent(url.pathname.slice('/v2/sessions/'.length));
                exactReads.push(id);
                if (id === 'team-withdrawn' && accessWithdrawn) return Response.json({ error: 'Session not found' }, { status: 404 });
                return Response.json({ session: id === 'team-withdrawn' ? teamRow
                    : sessionRow(id, { seq: accessWithdrawn ? 2 : 1, updatedAt: accessWithdrawn ? 2 : 1 }) });
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        }), { preferExactSnapshot: true }));
        const syncBridge = await loadSyncSingletonForTests();
        registerStandardCleanupTarget({ unmount: syncBridge.dispose });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://withdrawal-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://withdrawal-b.example.test', name: 'Withdrawal B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'withdrawal-account-b' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'withdrawal-group', name: 'Withdrawal', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'withdrawal-group',
        });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['current-head']), { timeout: 15_000 });
        await cache.refreshConcurrentMachineList(secondary.id);
        await cache.loadNextConcurrentOrdinarySessionListPage(secondary.id);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['current-head', 'team-withdrawn', 'still-admitted', 'temporarily-unavailable']);
        const frontier = cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier;
        storage.getState().applySessions([createSessionFixture({ id: 'team-withdrawn', serverId: secondary.id })]);
        storage.getState().applyServerScopedSessionListRows(secondary.id, [createSessionListRenderableSessionFixture({ id: 'team-withdrawn', archivedAt: 1 })], {
            source: 'archived', mode: 'append',
        });
        storage.getState().applyServerScopedSessionListRows(active.id, [createSessionListRenderableSessionFixture({ id: 'team-withdrawn' })], {
            source: 'ordinary', mode: 'append',
        });
        const controller = createSessionListQueryHomeController({
            serverId: secondary.id,
            fetchPage: (page) => cache.fetchConcurrentSessionListQueryPage(secondary.id, page),
        });
        const query: SessionListQueryV1 = {
            v: 1, storage: 'active', includeInactive: false, scope: 'all_accessible', attention: 'any',
            audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: true,
        };
        await controller.update({ query, selected: true, online: true, supported: true });
        expect(controller.getSnapshot().addresses.map((address) => address.sessionId)).toEqual(['team-withdrawn']);
        // A retained filtered page still requires retirement while its own reads
        // are paused. Head invalidation alone cannot remove its applied address.
        await controller.update({ query, selected: true, online: false, supported: true });
        const disposeQueryInvalidation = subscribeSessionListQueryHomeInvalidation(() => new Map([[secondary.id, controller]]));
        registerStandardCleanupTarget({ unmount: () => { disposeQueryInvalidation(); controller.dispose(); } });
        // Cold compact display reads precede the access-change operation under test.
        exactReads.length = 0;
        accessWithdrawn = true;
        const socket = socketState.byUrl.get(secondary.serverUrl);
        expect(socket).toBeDefined();
        socket!.dispatch('update', { id: 'coarse-access-change', seq: 1, createdAt: 1,
            body: { t: 'account-change', changeKinds: ['session'] } });
        await vi.waitFor(() => expect(cursors).toEqual([null, 'second-page', null]));
        await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready'));
        expect(exactReads).toEqual([]);
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['team-withdrawn']).toBeDefined();
        const { fetchSessionByIdWithServerScope } = await import('./serverScopedRpc/fetchSessionByIdWithServerScope');
        const nextRead = await fetchSessionByIdWithServerScope({ sessionId: 'team-withdrawn', serverId: secondary.id,
            contentDemand: 'list-projection', activeCredentials: { token: 'active-home' },
            activeRequest: async (path, init) => fetch(new URL(path, active.serverUrl), init),
            sessionDataKeys: new Map(), includeTurnsProjection: false, applySessions() {}, log: { log() {} },
        });
        expect(nextRead).toMatchObject({ ok: false, errorCode: 'not_found' });
        const admittedRead = await fetchSessionByIdWithServerScope({ sessionId: 'still-admitted', serverId: secondary.id,
            contentDemand: 'list-projection', activeCredentials: { token: 'active-home' },
            activeRequest: async (path, init) => fetch(new URL(path, active.serverUrl), init),
            sessionDataKeys: new Map(), includeTurnsProjection: false, applySessions() {}, log: { log() {} },
        });
        expect(admittedRead).toMatchObject({ ok: true, sessionListRenderable: { id: 'still-admitted', seq: 2 } });
        exactReads.length = 0;
        socket!.dispatch('update', { id: 'explicit-access-loss', seq: 2, createdAt: 2,
            body: withdrawal === 'account-change'
                ? { t: 'account-change', changeKinds: ['session'], entityIds: ['team-withdrawn', 'not-retained', 'team-withdrawn'] }
                : { t: 'session-share-revoked', sessionId: 'team-withdrawn', shareId: 'direct-share' } });
        await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['team-withdrawn'])
            .toBeUndefined(), { timeout: 5_000 });
        const expectedCursors = withdrawal === 'account-change'
            ? [null, 'second-page', null, null] : [null, 'second-page', null];
        await vi.waitFor(() => expect(cursors).toEqual(expectedCursors));
        await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready'));
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['current-head', 'still-admitted', 'temporarily-unavailable']);
        expect(storage.getState().archivedSessionListMembershipByServerId[secondary.id]).not.toContain('team-withdrawn');
        expect(storage.getState().sessions['team-withdrawn']).toBeUndefined();
        expect(controller.getSnapshot().addresses).toEqual([]);
        expect(storage.getState().sessionListRowsByServerId[active.id]?.['team-withdrawn']).toBeDefined();
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['still-admitted']?.seq).toBe(1);
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['temporarily-unavailable']).toBeDefined();
        expect(storage.getState().sessions['still-admitted']).toBeUndefined();
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready');
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);
        expect(cursors).toEqual(expectedCursors);
        expect(exactReads).toEqual(withdrawal === 'account-change' ? ['team-withdrawn'] : []);
    });

    it('retires only an auth-failed secondary Home corpus and repopulates after exact credential replacement', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const oldToken = token('auth-account-b');
        const replacementToken = token('auth-account-b-replacement');
        vi.stubGlobal('fetch', compactFetch(vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') return sessionPage('auth-row', null);
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://auth-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://auth-b.example.test', name: 'Auth B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(
                secondary.serverUrl,
                { serverId: secondary.id },
                { token: oldToken },
            );
        });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'auth-group', name: 'Auth', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'auth-group',
        });
        try {
            cache.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
                .toEqual(['auth-row']), { timeout: 15_000 });
            storage.getState().applyServerScopedSessionListRows(
                active.id,
                [createSessionListRenderableSessionFixture({ id: 'active-row' })],
                { source: 'ordinary', mode: 'replace' },
            );
            const rowsBeforeFailure = storage.getState().sessionListRowsByServerId[secondary.id];
            const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            reachability.reportServerAuthFailed(secondary.serverUrl, 401, undefined, oldToken);
            await vi.waitFor(() => {
                expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBeUndefined();
                expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBeUndefined();
                expect(storage.getState().sessionListIndexByServerId[secondary.id]).toBeUndefined();
            });
            expect(rowsBeforeFailure?.['auth-row']).toBeDefined();
            expect(storage.getState().sessionListRowsByServerId[active.id]?.['active-row']).toBeDefined();
            expect(storage.getState().ordinarySessionListMembershipByServerId[active.id]).toEqual(['active-row']);
            const { createActivityAttentionStoreSourceSelector } = await import('@/activity/source/createActivityAttentionStoreSourceSelector');
            const activityAfterFailure = createActivityAttentionStoreSourceSelector()(storage.getState());
            expect(activityAfterFailure.ordinarySessionListMembershipByServerId[secondary.id]).toBeUndefined();
            expect(activityAfterFailure.ordinarySessionListMembershipByServerId[active.id]).toEqual(['active-row']);

            await act(async () => {
                await TokenStorage.setCredentialsForServerUrl(
                    secondary.serverUrl,
                    { serverId: secondary.id },
                    { token: replacementToken },
                );
            });
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
                .toEqual(['auth-row']), { timeout: 15_000 });
        } finally {
            cache.stopConcurrentSessionCacheSync();
        }
    });

    it('preserves verified secondary rows across bindings and retires changed Account rows before the new binding publishes', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const newAccountPage = createDeferred<void>();
        const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const originalToken = token('binding-account-b');
        const replacementToken = token('binding-account-next');
        let blockReplacement = false;
        vi.stubGlobal('fetch', compactFetch(vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname.startsWith('/v2/sessions')) {
                if (blockReplacement && new Headers(init?.headers).get('authorization') === `Bearer ${replacementToken}`) {
                    await newAccountPage.promise;
                    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                }
                if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                return url.searchParams.has('cursor')
                    ? sessionPage('retained-page-two', null)
                    : sessionPage('retained-page-one', 'second-page');
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://binding-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://binding-b.example.test', name: 'Binding B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: originalToken });
        });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'binding-group', name: 'Binding', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'binding-group',
        });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['retained-page-one']), { timeout: 15_000 });
        await cache.refreshConcurrentMachineList(secondary.id);
        await cache.loadNextConcurrentOrdinarySessionListPage(secondary.id);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['retained-page-one', 'retained-page-two']);
        const rows = storage.getState().sessionListRowsByServerId[secondary.id];
        const membership = storage.getState().ordinarySessionListMembershipByServerId[secondary.id];
        const frontier = cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier;
        const replacementBindingMemberships: Array<readonly string[] | undefined> = [];
        const first = await renderHook(() => {
            const bindings = useServerCredentialAccountScopes([secondary.id]);
            if (bindings.get(secondary.id)?.accountId === 'binding-account-next') {
                replacementBindingMemberships.push(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]);
            }
            return bindings;
        });
        const second = await renderHook(() => useServerCredentialAccountScopes([secondary.id]));
        await vi.waitFor(() => expect(second.getCurrent().get(secondary.id)?.accountId).toBe('binding-account-b'));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBe(rows);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBe(membership);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);

        const previousBinding = first.getCurrent().get(secondary.id)!;
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: originalToken });
        });
        await vi.waitFor(() => expect(first.getCurrent().get(secondary.id)).not.toBe(previousBinding));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBe(rows);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);

        blockReplacement = true;
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: replacementToken });
        });
        await vi.waitFor(() => expect(first.getCurrent().get(secondary.id)?.accountId).toBe('binding-account-next'));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBeUndefined();
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBeUndefined();
        expect(replacementBindingMemberships.length).toBeGreaterThan(0);
        expect(replacementBindingMemberships.every((ids) => ids === undefined)).toBe(true);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({
            hasFetchedSnapshot: false, frontier: { nextCursor: null, hasNext: false },
        });
        newAccountPage.resolve();
    });

    it('preserves same-Account rows while replacement transport acquisition is pending or fails', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const acquiring = createDeferred<void>();
        const acquisition = createDeferred<void>();
        let ordinaryReads = 0;
        // Only the native byte-carrier lifecycle is substituted. The real
        // profile, carrier policy, supervisor, cache and credential owners run.
        getIrohHomeTunnelRuntime({
            native: {
                async ensureHomeTunnel() {
                    acquiring.resolve();
                    await acquisition.promise;
                    throw new Error('Native carrier is unavailable');
                },
                async releaseHomeTunnel() {},
            },
        });
        vi.stubGlobal('fetch', compactFetch(vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') {
                ordinaryReads += 1;
                return sessionPage('retained-during-acquisition', null);
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const runtime = await import('@/sync/domains/server/serverRuntime');
            const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://rotation-a.example.test', scope: 'tab' });
            const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://rotation-b.example.test', name: 'Rotation B' });
            const homeId = 'srv_rotation_b';
            await profiles.setServerProfileIdentityForUrl(secondary.serverUrl, homeId);
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'rotation-account-b' })).toString('base64url')}.signature`;
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: homeId }, { token });
            await profiles.saveHomeViewState({
                version: 1, groups: [{ id: 'rotation-group', name: 'Rotation', serverIds: [active.id, homeId] }],
                activeTargetKind: 'group', activeTargetId: 'rotation-group',
            });
            cache.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[homeId])
                .toEqual(['retained-during-acquisition']), { timeout: 15_000 });
            const rows = storage.getState().sessionListRowsByServerId[homeId];
            const membership = storage.getState().ordinarySessionListMembershipByServerId[homeId];
            const frontier = cache.readConcurrentOrdinarySessionListLifecycle(homeId).frontier;
            // A completed HTTP snapshot is not proof that its socket exists.
            await vi.waitFor(() => expect(socketState.byUrl.has(secondary.serverUrl), JSON.stringify({
                socketEndpoints: [...socketState.byUrl.keys()],
                online: cache.isConcurrentSessionListQueryHomeOnline(homeId),
                observation: storage.getState().concurrentSessionListCacheByServerId[homeId]?.listObservation,
                ordinaryReads,
            })).toBe(true));
            const previousSocket = socketState.byUrl.get(secondary.serverUrl)!;
            await profiles.reconcileServerProfileHomeConnectionDescriptor({
                serverUrl: secondary.serverUrl, observedServerIdentityId: homeId,
                descriptor: {
                    v: 1, homeServerIdentityId: homeId, canonicalServerUrl: secondary.serverUrl, revision: 1,
                    endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64), relayUrls: ['https://relay.example.test'] }],
                },
            });
            await acquiring.promise;
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: homeId }, {
                token: token.replace('.signature', '.rotated-signature'),
            });
            const binding = await renderHook(() => useServerCredentialAccountScopes([homeId]));
            await vi.waitFor(() => expect(binding.getCurrent().get(homeId)?.accountId).toBe('rotation-account-b'));
            expect(storage.getState().sessionListRowsByServerId[homeId]).toBe(rows);
            expect(storage.getState().ordinarySessionListMembershipByServerId[homeId]).toBe(membership);
            expect(cache.readConcurrentOrdinarySessionListLifecycle(homeId).frontier).toBe(frontier);
            expect(previousSocket.connected).toBe(false);
            expect(cache.isConcurrentSessionListQueryHomeOnline(homeId)).toBe(false);
            const readsBeforeRefresh = ordinaryReads;
            await cache.refreshConcurrentOrdinarySessionList(homeId);
            expect(ordinaryReads).toBe(readsBeforeRefresh);
            acquisition.resolve();
            await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[homeId]?.listObservation?.phase)
                .toBe('offline'));
            expect(storage.getState().sessionListRowsByServerId[homeId]).toBe(rows);
            expect(cache.getConcurrentSessionListQueryHomeAvailability(homeId)).toBe('offline');
            await cache.refreshConcurrentOrdinarySessionList(homeId);
            expect(ordinaryReads).toBe(readsBeforeRefresh);
            const remounted = await renderHook(() => useServerCredentialAccountScopes([homeId]));
            await vi.waitFor(() => expect(remounted.getCurrent().get(homeId)?.accountId).toBe('rotation-account-b'));
            expect(storage.getState().ordinarySessionListMembershipByServerId[homeId]).toBe(membership);
        } finally {
            acquisition.resolve();
        }
    });

    it('preserves same-Account rows after socket construction fails and releases the failed subscription before retry', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        let recovered = false;
        let ordinaryReads = 0;
        vi.stubGlobal('fetch', compactFetch(vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') {
                ordinaryReads += 1;
                return sessionPage(recovered ? 'recovered-after-connect-error' : 'retained-after-connect-error', null);
            }
            if (url.pathname === '/v2/sessions/retained-after-connect-error') {
                return Response.json({ session: sessionRow('retained-after-connect-error') });
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        }), { preferExactSnapshot: true }));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://connect-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://connect-b.example.test', name: 'Connect B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'connect-account-b' })).toString('base64url')}.signature`;
        const rotatedToken = token.replace('.signature', '.rotated-signature');
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'connect-group', name: 'Connect', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'connect-group',
        });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['retained-after-connect-error']), { timeout: 15_000 });
        const rows = storage.getState().sessionListRowsByServerId[secondary.id];
        const membership = storage.getState().ordinarySessionListMembershipByServerId[secondary.id];
        const frontier = cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier;
        const previousSocket = socketState.byUrl.get(secondary.serverUrl)!;
        // Another real reader already owns this Home's reachability. The new
        // cache subscription receives its online state synchronously, so a
        // socket-library construction failure must roll back that subscription.
        const otherReader = await reachability.acquireServerReachabilitySupervisor({
            serverUrl: secondary.serverUrl, token: rotatedToken,
        });
        try {
            expect(reachability.peekServerReachabilityState(secondary.serverUrl, rotatedToken)?.phase).toBe('online');
            socketState.failForToken = rotatedToken;
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: rotatedToken });
            await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
                .toBe('offline'));
            const binding = await renderHook(() => useServerCredentialAccountScopes([secondary.id]));
            await vi.waitFor(() => expect(binding.getCurrent().get(secondary.id)?.accountId).toBe('connect-account-b'));
            expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBe(rows);
            expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBe(membership);
            expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);
            expect(previousSocket.connected).toBe(false);
            expect(cache.getConcurrentSessionListQueryHomeAvailability(secondary.id)).toBe('offline');
            const readsBeforeRefresh = ordinaryReads;
            await cache.refreshConcurrentOrdinarySessionList(secondary.id);
            expect(ordinaryReads).toBe(readsBeforeRefresh);
            await otherReader.release();
            expect(reachability.peekServerReachabilityState(secondary.serverUrl, rotatedToken)).toBeNull();
            socketState.failForToken = null;
            recovered = true;
            await cache.retryConcurrentSessionListQueryHome(secondary.id);
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
                .toEqual(['retained-after-connect-error', 'recovered-after-connect-error']));
            expect(cache.getConcurrentSessionListQueryHomeAvailability(secondary.id)).toBe('online');
        } finally {
            socketState.failForToken = null;
            await otherReader.release();
        }
    });

    it('coalesces in-flight replacement requests and settles them only after page one replaces the corpus', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const continuation = createDeferred<Response>();
        const replacement = createDeferred<Response>();
        const requestedCursors: Array<string | null> = [];
        let failRefresh = false;
        vi.stubGlobal('fetch', compactFetch(vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') {
                if (url.hostname === 'refresh-c.example.test') return sessionPage('other-home', null);
                const cursor = url.searchParams.get('cursor');
                requestedCursors.push(cursor);
                if (requestedCursors.length === 1) return sessionPage('old-first', 'second-page');
                if (requestedCursors.length === 2) return continuation.promise;
                if (requestedCursors.length === 3) return replacement.promise;
                return failRefresh ? Response.json({}, { status: 503 }) : sessionPage('after-retry', null);
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        })));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://refresh-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://refresh-b.example.test', name: 'Refresh B' });
        const other = await profiles.upsertServerProfile({ serverUrl: 'https://refresh-c.example.test', name: 'Refresh C' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'refresh-account-b' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await TokenStorage.setCredentialsForServerUrl(other.serverUrl, { serverId: other.id }, { token });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'refresh-group', name: 'Refresh', serverIds: [active.id, secondary.id, other.id] }],
            activeTargetKind: 'group', activeTargetId: 'refresh-group',
        });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(requestedCursors).toEqual([null]), { timeout: 15_000 });
        await cache.refreshConcurrentMachineList(secondary.id);
        const loadingNext = cache.loadNextConcurrentOrdinarySessionListPage(secondary.id);
        await vi.waitFor(() => expect(requestedCursors).toEqual([null, 'second-page']), { timeout: 15_000 });
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['old-first']);
        let settled = 0;
        const refreshes = [cache.refreshConcurrentOrdinarySessionList(secondary.id), cache.refreshConcurrentOrdinarySessionList(secondary.id)];
        for (const refresh of refreshes) void refresh.then(() => { settled += 1; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(0);
        await cache.refreshConcurrentOrdinarySessionList(other.id);
        expect(storage.getState().ordinarySessionListMembershipByServerId[other.id]).toEqual(['other-home']);
        expect(settled).toBe(0);
        continuation.resolve(sessionPage('old-second', 'third-page'));
        await vi.waitFor(() => expect(requestedCursors).toHaveLength(3), { timeout: 5_000 });
        expect(requestedCursors).toEqual([null, 'second-page', null]);
        expect(settled).toBe(0);
        replacement.resolve(sessionPage('new-first', null));
        await Promise.all([loadingNext, ...refreshes]);
        expect(settled).toBe(2);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['new-first']);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({
            hasFetchedSnapshot: true, frontier: { nextCursor: null, hasNext: false },
        });
        failRefresh = true;
        await cache.refreshConcurrentOrdinarySessionList(secondary.id);
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('error');
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['new-first']);
        failRefresh = false;
        await cache.refreshConcurrentOrdinarySessionList(secondary.id);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['after-retry']);
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready');
    });

    it('does not let strict-query acquisition or disposal mark an unfetched Home ordinary list ready', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const ordinaryPage = createDeferred<Response>();
        let secondaryServerUrl = '';
        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions/query') {
                return Response.json(createSessionListSourceFixture({
                    sessions: [{ ...sessionRow('query-only', {
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'unopenable-envelope',
                        metadata: 'encrypted-unopenable-metadata',
                    }), responsibleAccountId: null, responsibleAccount: null,
                    viewer: {
                        latestFailureSeq: null,
                        readState: { state: 'not_started' },
                        relevance: { relevant: true, reasons: ['owned_by_me'] },
                        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                        follow: { follows: false, notificationLevel: null },
                        notification: { level: 'important', source: 'owner' },
                    } }],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: null,
                    attentionHasNext: false,
                }));
            }
            if (url.pathname === '/v2/sessions') {
                if (url.origin === secondaryServerUrl) return ordinaryPage.promise;
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', compactFetch(fetchSpy));

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://query-observation-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://query-observation-b.example.test', name: 'Query Observation B' });
        secondaryServerUrl = secondary.serverUrl;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'query-observation-account' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'query-observation-group', name: 'Query Observation', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'query-observation-group',
        });

        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(cache.isConcurrentSessionListQueryHomeOnline(secondary.id)).toBe(true), { timeout: 15_000 });
        await vi.waitFor(() => expect(fetchSpy.mock.calls.some(([input]) => {
            const url = new URL(String(input));
            return url.origin === secondaryServerUrl && url.pathname === '/v2/sessions';
        })).toBe(true), { timeout: 15_000 });
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({ hasFetchedSnapshot: false });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
            .toBe('loading');

        const query: SessionListQueryV1 = {
            v: 1,
            storage: 'active',
            includeInactive: false,
            scope: 'all_accessible',
            attention: 'any',
            audiences: { include: [], exclude: [] },
            tagIds: { include: [], exclude: [] },
            includeAttention: true,
        };
        const controller = createSessionListQueryHomeController({
            serverId: secondary.id,
            fetchPage: (page) => cache.fetchConcurrentSessionListQueryPage(secondary.id, page),
        });
        await controller.update({ query, selected: true, online: true, supported: true });
        expect(controller.getSnapshot(), JSON.stringify(controller.getSnapshot()))
            .toMatchObject({ phase: 'ready', appliedSourceKind: 'query' });
        expect(controller.getSnapshot().addresses.map((address) => address.sessionId)).toEqual(['query-only']);
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['query-only']).toBeDefined();
        // Acquiring membership does not demand Session content. Its retained
        // projection still cannot declare the incumbent ordinary corpus ready.
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['query-only']?.metadata).toBeNull();
        expect(storage.getState().sessions['query-only']).toBeUndefined();

        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({ hasFetchedSnapshot: false });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
            .toBe('loading');
        controller.dispose();
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({ hasFetchedSnapshot: false });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
            .toBe('loading');

        ordinaryPage.resolve(sessionPage('ordinary-after-query', null));
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['ordinary-after-query']), { timeout: 15_000 });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready');
    });

    it('measures real secondary snapshots and socket coalescing without Home attribution', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `cache_telemetry_${Date.now()}`;
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        let blockNextSessionSnapshot = false;
        const snapshotGate: { release?: () => void } = {};
        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/v1/auth/ping')) {
                return Response.json({ ok: true });
            }
            if (url.includes('/v2/sessions')) {
                if (blockNextSessionSnapshot) {
                    blockNextSessionSnapshot = false;
                    await new Promise<void>((resolve) => { snapshotGate.release = resolve; });
                }
                const body = JSON.stringify({ sessions: [], nextCursor: null, hasNext: false });
                return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
            }
            if (url.includes('/v1/machines')) {
                return new Response('[]', { status: 200, headers: { 'content-length': '2' } });
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal('fetch', compactFetch(fetchSpy));

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://home-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(
            secondary.serverUrl,
            { serverId: secondary.id },
            { token: 'secondary-token' },
        );
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'global-group', name: 'Global Group', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'global-group',
        });
        const { storage } = await import('@/sync/domains/state/storageStore');
        // Simulate a late focused-account projection carrying the pre-migration
        // selection. Once HomeView exists, this scoped copy has no authority.
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                serverSelectionGroups: [{
                    id: 'stale-group',
                    name: 'Stale Group',
                    serverIds: [active.id],
                    presentation: 'grouped',
                }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'stale-group',
            },
        }));

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const cache = await import('./concurrentSessionCache');
        // Loading the real graph instantiates focused Sync, which applies the
        // runtime telemetry setting. Enable capture after that production
        // composition side effect so the test observes the cache owner itself.
        syncPerformanceTelemetry.configure({ enabled: true });
        expect(syncPerformanceTelemetry.isEnabled()).toBe(true);
        expect(await TokenStorage.getCredentialsForServerUrl(
            secondary.serverUrl,
            { serverId: secondary.id },
        )).toMatchObject({ token: 'secondary-token' });
        cache.startConcurrentSessionCacheSync();
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await vi.waitFor(() => {
            expect(reachability.peekServerReachabilityState(secondary.serverUrl)).toMatchObject({ phase: 'online' });
        }, { timeout: 5_000 });
        await vi.waitFor(() => {
            expect(syncPerformanceTelemetry.snapshot().events.some((event) =>
                event.name === 'sync.concurrent.refresh')).toBe(true);
        }, { timeout: 15_000 });
        syncPerformanceTelemetry.reset();
        vi.useFakeTimers();

        blockNextSessionSnapshot = true;
        const secondarySocket = socketState.byUrl.get(secondary.serverUrl);
        secondarySocket?.dispatch('update', { body: { t: 'update-session' } });
        secondarySocket?.dispatch('update', { body: { t: 'update-session' } });
        await vi.advanceTimersByTimeAsync(601);
        await Promise.resolve();
        secondarySocket?.dispatch('update', { body: { t: 'update-session' } });
        await vi.advanceTimersByTimeAsync(601);
        snapshotGate.release?.();
        await vi.waitFor(() => {
            expect(syncPerformanceTelemetry.snapshot().events.some((event) =>
                event.name === 'sync.concurrent.refresh')).toBe(true);
        }, { timeout: 5_000 });

        const summary = syncPerformanceTelemetry.snapshot();
        const refresh = summary.events.find((event) => event.name === 'sync.concurrent.refresh');
        const socket = summary.events.find((event) => event.name === 'sync.concurrent.refresh.socket');
        expect(refresh?.fields.responseBytes).toBeGreaterThan(2);
        expect(refresh?.count).toBeGreaterThanOrEqual(1);
        expect(socket?.fields).toMatchObject({ enqueued: 2, coalesced: 1, inFlightQueued: 1 });
        expect(JSON.stringify(summary)).not.toContain(secondary.id);
        expect(JSON.stringify(summary)).not.toContain(secondary.serverUrl);

        const replacement = await profiles.upsertServerProfile({
            serverUrl: 'https://home-c.example.test',
            name: 'Home C',
        });
        await TokenStorage.setCredentialsForServerUrl(
            replacement.serverUrl,
            { serverId: replacement.id },
            { token: 'replacement-token' },
        );
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'global-next', name: 'Global Next', serverIds: [active.id, replacement.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'global-next',
        });
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(601);
        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]).toBeUndefined();
            expect(storage.getState().concurrentSessionListCacheByServerId[replacement.id]).toBeDefined();
        }, { timeout: 5_000 });

        cache.stopConcurrentSessionCacheSync();
        localStorageHandle.restore();
        restoreLocalStorage = null;
    });
});
