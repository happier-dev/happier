import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
    createDeferred,
    createMachineFixture,
    createRootLayoutFeaturesResponse,
    createSessionFixture,
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionOpsNetworkBoundary, type SessionOpsRpcRequest } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE } from '@/sync/runtime/sessionMachineRpcErrorCodes';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { sessionTagKey } from '../sessionTagUtils';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// Provider decisions, Account custody, storage, selection and materialization stay
// real. Only Home HTTP, Socket.IO and the host platform are substituted.
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { storage } = await import('@/sync/domains/state/storage');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, setMachineAdministrationTargetPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { parseToken } = await import('@/utils/auth/parseToken');

const SERVER_A = 'srv_memory_a';
const SERVER_B = 'srv_memory_b';
const HOME_B = 'srv_memory_list_b';
const homes = [
    {
        serverId: SERVER_A,
        serverUrl: 'https://server-a',
        accountId: 'account-a',
    },
    {
        serverId: SERVER_B,
        serverUrl: 'https://server-b',
        accountId: 'account-b',
    },
    {
        serverId: HOME_B,
        serverUrl: 'https://home-b',
        accountId: 'account-b',
    },
] as const;

type DaemonRequest = Omit<SessionOpsRpcRequest, 'token'> & {
    accountId: string;
    serverId: string;
    machineId: string;
};
type HomeSearchRequest = {
    serverId: string;
    accountId: string;
    query: string;
    signal: AbortSignal | null;
};

const daemonReply = vi.fn<(request: DaemonRequest) => Promise<unknown>>();
const homeReply = vi.fn<(request: HomeSearchRequest) => Promise<unknown>>();
const unavailableSessionIds = new Set<string>();
const inventory = new Map<string, Machine[]>();
const features = new Map<string, ReturnType<typeof createRootLayoutFeaturesResponse>>();
const connections: Array<Awaited<ReturnType<typeof restoreServerAccountForTest>>> = [];
let previousState = storage.getState();

function requestHome(serverUrl: string) {
    const home = homes.find(home => new URL(home.serverUrl).origin === new URL(serverUrl).origin);
    if (!home) {
        throw new Error('Unknown search fixture request origin');
    }
    return home;
}

function daemonRequests() {
    return network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH).map(request => {
        if (!request.token) throw new Error('Memory search fixture requires authenticated daemon RPC');
        return {
            serverId: requestHome(request.serverUrl).serverId,
            accountId: parseToken(request.token),
            machineId: request.targetId,
            method: request.method,
            payload: request.payload,
        };
    });
}

function sessionReadPaths() {
    return network.httpRequests.filter(request => request.method === 'GET')
        .map(request => new URL(request.url).pathname).filter(path => /^\/v2\/sessions\/[^/]+$/.test(path)
        && ![
            '/v2/sessions/query', '/v2/sessions/active', '/v2/sessions/metadata-upgrades', '/v2/sessions/read-batch'
        ].includes(path));
}

function sessionReadScopes() {
    return network.httpRequests.filter(request => request.method === 'GET'
        && sessionReadPaths().includes(new URL(request.url).pathname)).map(request => ({
        path: new URL(request.url).pathname,
        serverId: requestHome(request.url).serverId,
        accountId: parseToken(request.token!.replace(/^Bearer /, '')),
    }));
}

function sessionInventoryPaths() {
    return network.httpRequests.map(request => new URL(request.url).pathname).filter(path => [
        '/v2/sessions', '/v2/sessions/active', '/v2/sessions/query'
    ].includes(path));
}

function issuedSearchCalls() {
    return network.socketBoundaries.flatMap(({ socket }) => vi.mocked(socket.emitWithAck).mock.calls.flatMap(([event, payload]) => {
        if (event !== SOCKET_RPC_EVENTS.CALL || typeof payload !== 'object' || payload === null
            || !('requestId' in payload) || typeof payload.requestId !== 'string'
            || !('method' in payload) || typeof payload.method !== 'string'
            || !payload.method.endsWith(`:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`)) {
            return [];
        }
        return [{ requestId: payload.requestId, method: payload.method }];
    }));
}

function cancelledRequestIds() {
    return network.socketBoundaries.flatMap(({ socket }) => vi.mocked(socket.emit).mock.calls.flatMap(([event, payload]) => event === SOCKET_RPC_EVENTS.CANCEL && typeof payload === 'object' && payload !== null
        && 'requestId' in payload && typeof payload.requestId === 'string' ? [payload.requestId] : []));
}

function setMachines(machineIds: readonly string[], serverId: string = SERVER_A) {
    const home = homes.find(home => home.serverId === serverId)!;
    const machines = machineIds.map(id => {
        const row = createPlainMachineRowFixture({ id, accountId: home.accountId });
        return createMachineFixture({
            id,
            kind: 'persistent',
            active: true,
            activeAt: Date.now(),
            dataEncryptionKey: row.dataEncryptionKey,
            access: row.access,
        });
    });
    inventory.set(serverId, machines);
    storage.setState(state => ({
        machineListByServerId: { ...state.machineListByServerId, [serverId]: machines },
        machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
        ...(getActiveServerSnapshot().serverId === serverId ? { machines: Object.fromEntries(machines.map(machine => [machine.id, machine])) } : {}),
    }));
}

function selectMemoryMachine(machineId: string | null) {
    const key = MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory;
    const selections = { ...storage.getState().settings.machineAdministrationTargetsLocalV1 };
    delete selections[key];
    storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: machineId === null ? selections
            : setMachineAdministrationTargetPreference(selections, key, { serverIdentityId: SERVER_A, machineId }) });
}

function seedSessions(sessions: Readonly<Record<string, {
    id: string;
    serverId: string;
}>>) {
    storage.setState({ sessions: Object.fromEntries(Object.values(sessions).map(session => [session.id,
            createSessionFixture({
                ...session, active: true, seq: 3
            })])) });
}

function publishSearchFeatures(search: boolean, capability?: {
    enabled: boolean;
    reason?: 'indexing';
}) {
    for (const home of homes) {
        const response = createRootLayoutFeaturesResponse({ features: { search: { enabled: search } }, capabilities: {
                serverIdentity: { serverIdentityId: home.serverId }, ...(capability ? { homeSearch: capability } : {}),
            } });
        features.set(home.serverId, response);
        primeServerFeaturesSnapshot({ serverId: home.serverId, snapshot: { status: 'ready', features: response } });
    }
}

function withReadyHomeSearch() {
    publishSearchFeatures(true, { enabled: true });
}

function withoutSelectedMemoryMachine() {
    setMachines([]);
    selectMemoryMachine(null);
}

function createMemorySearchHit(sessionId: string, summary = 'Matching summary', score = 0.9) {
    return {
        sessionId,
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        summary,
        score,
    };
}

function result(hits: ReturnType<typeof createMemorySearchHit>[] = []) {
    return {
        v: 1 as const,
        ok: true as const,
        hits,
    };
}

async function focusHome(serverId: string, activation?: 'switch') {
    const home = homes.find(home => home.serverId === serverId);
    if (!home) {
        throw new Error('Unknown search fixture Home');
    }
    const connection = await restoreServerAccountForTest({
        serverUrl: home.serverUrl,
        serverIdentityId: serverId,
        accountId: home.accountId,
        request: network.request,
        activation,
        additionalRequestOrigins: homes.map(home => home.serverUrl),
    });
    connections.push(connection);
    await waitForAccountBootstrap(serverId, home.accountId);
    storage.getState().applySettingsLocal({
        experiments: true,
        featureToggles: { 'memory.search': true },
        machineAdministrationTargetsLocalV1: {},
    });
    for (const home of homes) {
        setMachines(home.serverId === SERVER_A ? ['machine-a'] : [], home.serverId);
    }
    selectMemoryMachine('machine-a');
}

async function waitForAccountBootstrap(serverId: string, accountId: string) {
    // Connection restoration schedules core bootstrap in the background. Wait
    // for its real Settings/Profile result before publishing local search inputs.
    await waitForHomeGovernance(() => {
        const state = storage.getState();
        expect(state.settingsScope).toEqual({ serverId, accountId });
        expect(state.settingsVersion).toBeGreaterThan(0);
        expect(state.profileScope).toEqual({ serverId, accountId });
        expect(state.profile.id).toBe(accountId);
        expect(state.isDataReady).toBe(true);
    });
}

beforeEach(async () => {
    previousState = storage.getState();
    network.resetRequests();
    unavailableSessionIds.clear();
    inventory.clear();
    resetServerFeaturesClientForTests();
    daemonReply.mockReset();
    daemonReply.mockResolvedValue(result());
    homeReply.mockReset();
    homeReply.mockResolvedValue(result());
    for (const home of homes) {
        await network.addHome(home.serverUrl, home.accountId);
        await setServerProfileIdentityForUrl(home.serverUrl, home.serverId);
        if (home.serverId === SERVER_A) {
            // Seed the later replacement Account through the same Settings HTTP
            // boundary, then restore Account A's credential before activating it.
            await network.addHome(home.serverUrl, 'account-b');
        }
        await network.addHome(home.serverUrl, home.accountId);
        inventory.set(home.serverId, home.serverId === SERVER_A ? [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })] : []);
    }
    publishSearchFeatures(false);
    network.setRpcResponder(request => {
        if (!request.token) throw new Error('Memory search fixture requires authenticated daemon RPC');
        return daemonReply({
            serverUrl: request.serverUrl, targetId: request.targetId,
            method: request.method, payload: request.payload, timeoutMs: request.timeoutMs,
            serverId: requestHome(request.serverUrl).serverId, accountId: parseToken(request.token), machineId: request.targetId,
        });
    });
    network.setHttpResponder(async (input, init) => {
        const url = new URL(String(input));
        const home = requestHome(url.origin);
        if (url.pathname === '/v1/features') {
            return Response.json(features.get(home.serverId));
        }
        if (url.pathname === '/v1/account/encryption/currentness') {
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (url.pathname === '/v1/account/profile') {
            const accountId = parseToken(new Headers(init?.headers).get('authorization')!.replace(/^Bearer /, ''));
            return Response.json(AccountProfileSchema.parse({ id: accountId }));
        }
        if (url.pathname === '/v1/home/search') {
            const query = JSON.parse(String(init?.body)) as {
                query: string;
            };
            const accountId = parseToken(new Headers(init?.headers).get('authorization')!.replace(/^Bearer /, ''));
            return Response.json(await homeReply({
                serverId: home.serverId, accountId, query: query.query, signal: init?.signal ?? null
            }));
        }
        if (url.pathname === '/v1/machines') {
            return Response.json((inventory.get(home.serverId) ?? []).map(machine => ({ ...createPlainMachineRowFixture({ id: machine.id, accountId: home.accountId }), activeAt: machine.activeAt })));
        }
        const match = url.pathname.match(/^\/v2\/sessions\/([^/]+)$/);
        if (match && (init?.method ?? 'GET') === 'GET' && ![
            'query', 'active', 'metadata-upgrades', 'read-batch'
        ].includes(match[1]!)) {
            const id = decodeURIComponent(match[1]!);
            if (unavailableSessionIds.has(id)) {
                return Response.json({ error: 'Unavailable' }, { status: 500 });
            }
            return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({
                id, serverId: home.serverId, seq: 3,
                active: true, metadata: {
                    path: `/work/${id}`, host: 'tester.local', machineId: 'machine-a'
                },
            })));
        }
        return createEmptyAccountBootstrapHttpResponse(url.pathname, init);
    });
    await focusHome(SERVER_A);
    // Account bootstrap is outside the search lifetime asserted below.
    network.requests.length = 0;
    network.httpRequests.length = 0;
    // Retain restored sockets: subsequent calls may reuse their existing transport.
    for (const { socket } of network.socketBoundaries) {
        vi.mocked(socket.emit).mockClear();
        vi.mocked(socket.emitWithAck).mockClear();
    }
});

afterEach(async () => {
    await standardCleanup();
    vi.useRealTimers();
    // Account replacement intentionally retires the connection captured at setup.
    // Close whichever real Account currently owns Sync before restoring the fixture.
    try {
        await disconnectActiveServerConnection();
    } finally {
        try {
            // A warm Home switch creates another rollback handle; release both in
            // reverse order so the prior Home's device boundary is not left installed.
            for (const connection of connections.splice(0).reverse()) {
                await connection.dispose();
            }
            await serverScopedRpcSocketPool.stopAll();
        } finally {
            clearMachineRequestReachabilityForTest();
            resetScopedMachineTransportCacheForTests();
            storage.setState(previousState, true);
            resetServerFeaturesClientForTests();
        }
    }
});

afterAll(() => network.dispose());

async function renderMemoryAugmentationHook(props: Readonly<{
    searchQuery: string;
    enabled?: boolean;
    eligibleSessionIds?: readonly string[];
}>) {
    const { useSessionListMemorySearchAugmentation } = await import('./useSessionListMemorySearchAugmentation');
    return renderHook((nextProps: typeof props) => useSessionListMemorySearchAugmentation(nextProps), { initialProps: props });
}

describe('useSessionListMemorySearchAugmentation', () => {
    it('keys results by Account, provider, exact Home/server, and daemon machine', async () => {
        const { buildSessionListMemorySearchScopeKey } = await import('./useSessionListMemorySearchAugmentation');
        const base = {
            accountScope: { serverId: SERVER_A, accountId: 'account-a' },
            provider: 'daemon' as const,
            serverId: SERVER_A,
            machineId: 'machine-a',
        };
        const identities = [
            buildSessionListMemorySearchScopeKey(base),
            buildSessionListMemorySearchScopeKey({ ...base, accountScope: { serverId: SERVER_A, accountId: 'account-b' } }),
            buildSessionListMemorySearchScopeKey({
                ...base, provider: 'home', machineId: null
            }),
            buildSessionListMemorySearchScopeKey({ ...base, serverId: SERVER_B }),
            buildSessionListMemorySearchScopeKey({ ...base, machineId: 'machine-b' })
        ];
        expect(new Set(identities).size).toBe(identities.length);
    });

    it('retires both the contextual query and rows when machine or provider authority switches', async () => {
        vi.useFakeTimers();
        setMachines(['machine-a', 'machine-b']);
        selectMemoryMachine('machine-a');
        seedSessions({ 'same-session': { id: 'same-session', serverId: SERVER_A } });
        daemonReply.mockResolvedValue(result([createMemorySearchHit('same-session')]));
        const { useSessionListViewFilters } = await import('./useSessionListViewFilters');
        const { useSessionListMemorySearchAugmentationForContext, useSessionListMemorySearchContext } = await import('./useSessionListMemorySearchAugmentation');
        const hook = await renderHook(() => {
            const context = useSessionListMemorySearchContext();
            const filters = useSessionListViewFilters({
                contextKey: `all\u0000account-a:list-home-a\u0000transcript:${context.activeScopeKey}`,
                accountScopeResolutions: new Map([[SERVER_A, { kind: 'bound' as const, scope: { serverId: SERVER_A, accountId: 'account-a' } }]]), defaults: {}
            });
            const memory = useSessionListMemorySearchAugmentationForContext({ searchQuery: filters.filters.searchQuery }, context);
            return {
                searchQuery: filters.filters.searchQuery, setSearchQuery: filters.setSearchQuery, memory
            };
        });
        await act(async () => hook.getCurrent().setSearchQuery('private-query'));
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect([...hook.getCurrent().memory.memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'same-session')]);
        await act(async () => selectMemoryMachine('machine-b'));
        expect(hook.getCurrent().searchQuery).toBe('');
        expect([...hook.getCurrent().memory.memoryMatchedSessionKeys]).toEqual([]);
        await act(async () => hook.getCurrent().setSearchQuery('private-query'));
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect([...hook.getCurrent().memory.memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'same-session')]);
        await act(async () => withReadyHomeSearch());
        expect(hook.getCurrent().searchQuery).toBe('');
        expect([...hook.getCurrent().memory.memoryMatchedSessionKeys]).toEqual([]);
    });

    it('queries and keys Home results to the list-selected Home instead of the focused Home', async () => {
        vi.useFakeTimers();
        withReadyHomeSearch();
        seedSessions({ 'same-session': { id: 'same-session', serverId: HOME_B } });
        homeReply.mockResolvedValue(result([createMemorySearchHit('same-session')]));
        const { useSessionListMemorySearchAugmentationForContext, useSessionListMemorySearchContext } = await import('./useSessionListMemorySearchAugmentation');
        const hook = await renderHook(() => useSessionListMemorySearchAugmentationForContext({ searchQuery: 'vector' }, useSessionListMemorySearchContext({ serverId: HOME_B })));
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(getActiveServerSnapshot().serverId).toBe(SERVER_A);
        expect(homeReply).toHaveBeenCalledWith(expect.objectContaining({ serverId: HOME_B, accountId: 'account-b' }));
        expect(sessionReadScopes()).toEqual([{
                path: '/v2/sessions/same-session', serverId: HOME_B, accountId: 'account-b'
            }]);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(HOME_B, 'same-session')]);
        expect(hook.getCurrent().memoryMatchedSessionTargets).toEqual([expect.objectContaining({ serverId: HOME_B, sessionId: 'same-session' })]);
    });

    it('keeps a one-character query local and starts neither provider search nor Session-list inventory', async () => {
        vi.useFakeTimers();
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'v' });
        await flushHookEffects({ advanceTimersMs: 500, cycles: 2 });
        expect(daemonRequests()).toEqual([]);
        expect(homeReply).not.toHaveBeenCalled();
        expect(sessionReadPaths()).toEqual([]);
        expect(sessionInventoryPaths()).toEqual([]);
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('starts only the bounded provider at the accepted query threshold', async () => {
        vi.useFakeTimers();
        const hook = await renderMemoryAugmentationHook({ searchQuery: 've' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(daemonRequests()).toHaveLength(1);
        expect(homeReply).not.toHaveBeenCalled();
        expect(sessionReadPaths()).toEqual([]);
        expect(sessionInventoryPaths()).toEqual([]);
        expect(hook.getCurrent().lastSuccessfulQuery).toBe('ve');
    });

    it('authorizes provider hits row by row without fetching current or archived Session-list pages', async () => {
        vi.useFakeTimers();
        daemonReply.mockResolvedValue(result([createMemorySearchHit('session-1')]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(sessionReadPaths()).toEqual(['/v2/sessions/session-1']);
        expect(sessionInventoryPaths()).toEqual([]);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-1')]);
    });

    it('does not call the daemon when the surface is not data-active', async () => {
        vi.useFakeTimers();
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector', enabled: false });
        await flushHookEffects({ advanceTimersMs: 500, cycles: 2 });
        expect(daemonRequests()).toEqual([]);
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('queries the canonical daemon search seam without a status preflight', async () => {
        vi.useFakeTimers();
        const search = createDeferred<unknown>();
        daemonReply.mockImplementation(request => {
            if (request.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)
                return search.promise;
            throw new Error('Unexpected RPC');
        });
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 2 });
        expect(daemonRequests()).toEqual([expect.objectContaining({
                method: RPC_METHODS.DAEMON_MEMORY_SEARCH, machineId: 'machine-a', serverId: SERVER_A
            })]);
        expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MEMORY_STATUS)).toEqual([]);
        expect(hook.getCurrent().isSearchingMemory).toBe(true);
    });

    it('passes contextual Session eligibility through the shared daemon adapter', async () => {
        vi.useFakeTimers();
        seedSessions({ 'archived-session': { id: 'archived-session', serverId: SERVER_A } });
        daemonReply.mockResolvedValue(result([createMemorySearchHit('archived-session')]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector', eligibleSessionIds: ['archived-session'] });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(daemonRequests()).toEqual([expect.objectContaining({ method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
                payload: expect.objectContaining({ eligibleSessionIds: ['archived-session'] }) })]);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'archived-session')]);
    });

    it('publishes every valid daemon hit, including sessions outside the rendered list', async () => {
        vi.useFakeTimers();
        seedSessions({ 'session-1': { id: 'session-1', serverId: SERVER_A } });
        daemonReply.mockResolvedValue(result([createMemorySearchHit('session-1'), createMemorySearchHit('session-2', 'Out of scope summary')]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(daemonRequests()).toEqual([expect.objectContaining({
                accountId: 'account-a', serverId: SERVER_A,
                payload: expect.objectContaining({ query: 'vector', maxResults: 50 })
            })]);
        expect(sessionReadPaths().sort()).toEqual(['/v2/sessions/session-1', '/v2/sessions/session-2']);
        expect(sessionInventoryPaths()).toEqual([]);
        expect(sessionReadScopes()).toEqual([
            {
                path: '/v2/sessions/session-1', serverId: SERVER_A, accountId: 'account-a'
            },
            {
                path: '/v2/sessions/session-2', serverId: SERVER_A, accountId: 'account-a'
            },
        ]);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-1'), sessionTagKey(SERVER_A, 'session-2')]);
        expect(hook.getCurrent().memoryMatchedSessionTargets.map(target => target.sessionId)).toEqual(['session-1', 'session-2']);
        expect(hook.getCurrent().memoryMatchedSessionTargets).toEqual([
            expect.objectContaining({
                sessionId: 'session-1', reasons: ['transcript'], sourceMachineId: 'machine-a'
            }),
            expect.objectContaining({
                sessionId: 'session-2', reasons: ['transcript'], sourceMachineId: 'machine-a'
            }),
        ]);
        expect(Object.keys(storage.getState().sessionListRowsByServerId[SERVER_A] ?? {}).sort()).toEqual(['session-1', 'session-2']);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('never renders a hit whose session the explicit-server reader cannot authorize', async () => {
        vi.useFakeTimers();
        seedSessions({ 'session-1': { id: 'session-1', serverId: SERVER_B } });
        unavailableSessionIds.add('session-1');
        daemonReply.mockResolvedValue(result([createMemorySearchHit('session-1', 'Stale index row')]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(sessionReadPaths()).toEqual(['/v2/sessions/session-1']);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([]);
        expect(hook.getCurrent().memoryMatchedSessionTargets).toEqual([]);
    });

    it('keeps current-query matches stable while unrelated inputs churn', async () => {
        vi.useFakeTimers();
        seedSessions({ 'session-1': { id: 'session-1', serverId: SERVER_A }, 'session-2': { id: 'session-2', serverId: SERVER_A } });
        let searchCallCount = 0;
        daemonReply.mockImplementation(async () => result(++searchCallCount === 1 ? [createMemorySearchHit('session-1', 'Initial summary')]
            : [createMemorySearchHit('session-1', 'Initial summary'), createMemorySearchHit('session-2', 'Expanded summary', 0.8)]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        const matches = hook.getCurrent().memoryMatchedSessionKeys;
        expect([...matches]).toEqual([sessionTagKey(SERVER_A, 'session-1')]);
        expect(searchCallCount).toBe(1);
        await hook.rerender({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 500, cycles: 4 });
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-1')]);
        expect(hook.getCurrent().memoryMatchedSessionKeys).toBe(matches);
        expect(searchCallCount).toBe(1);
        await hook.rerender({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 500, cycles: 4 });
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-1')]);
        expect(searchCallCount).toBe(1);
    });

    it('ignores stale daemon memory search responses', async () => {
        vi.useFakeTimers();
        seedSessions({ 'session-1': { id: 'session-1', serverId: SERVER_A }, 'session-2': { id: 'session-2', serverId: SERVER_A } });
        const firstSearch = createDeferred<unknown>();
        daemonReply.mockImplementation(request => (request.payload as {
            query: string;
        }).query === 'vector'
            ? firstSearch.promise : Promise.resolve(result([createMemorySearchHit('session-2', 'Fresh summary')])));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });
        await hook.rerender({ searchQuery: 'parser' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        firstSearch.resolve(result([createMemorySearchHit('session-1', 'Stale summary')]));
        await flushHookEffects({ cycles: 3 });
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-2')]);
        expect(hook.getCurrent().lastSuccessfulQuery).toBe('parser');
    });

    it('clears same-query rows immediately on Account replacement and never publishes retired work', async () => {
        vi.useFakeTimers();
        seedSessions({ 'same-session': { id: 'same-session', serverId: SERVER_A } });
        const accountASearch = createDeferred<unknown>();
        daemonReply.mockImplementation(request => {
            if (request.method !== RPC_METHODS.DAEMON_MEMORY_SEARCH)
                throw new Error('Unexpected RPC');
            if (request.accountId === 'account-a')
                return accountASearch.promise;
            if (request.accountId === 'account-b')
                return Promise.resolve(result());
            throw new Error('Unexpected search Account');
        });
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });
        const accountARequest = issuedSearchCalls()[0];
        expect(accountARequest).toBeDefined();
        await act(async () => {
            await network.setAccount('https://server-a', 'account-b');
        });
        const switched = hook.getCurrent();
        expect(cancelledRequestIds()).toContain(accountARequest!.requestId);
        expect([...switched.memoryMatchedSessionKeys]).toEqual([]);
        expect(switched.lastSuccessfulQuery).toBeUndefined();
        accountASearch.resolve(result([createMemorySearchHit('same-session', 'Account A transcript')]));
        await flushHookEffects({ cycles: 3 });
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([]);
        expect(hook.getCurrent().lastSuccessfulQuery).toBeUndefined();
        // The newly restored Account owns its own local settings and selection.
        await waitForAccountBootstrap(SERVER_A, 'account-b');
        await act(async () => {
            storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'memory.search': true } });
            setMachines(['machine-a']);
            selectMemoryMachine('machine-a');
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });
        expect(daemonRequests().map(request => request.accountId)).toEqual(['account-a', 'account-b']);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([]);
        expect(hook.getCurrent().lastSuccessfulQuery).toBe('vector');
    });

    it('cancels the superseded query through the machine RPC cancellation path', async () => {
        vi.useFakeTimers();
        seedSessions({ 'session-2': { id: 'session-2', serverId: SERVER_A } });
        const firstSearch = createDeferred<unknown>();
        daemonReply.mockImplementation(request => (request.payload as {
            query: string;
        }).query === 'vector'
            ? firstSearch.promise : Promise.resolve(result([createMemorySearchHit('session-2', 'Fresh summary')])));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });
        const firstCall = issuedSearchCalls()[0];
        expect(firstCall).toBeDefined();
        await hook.rerender({ searchQuery: 'parser' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(cancelledRequestIds()).toEqual([firstCall!.requestId]);
        firstSearch.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        await flushHookEffects({ cycles: 3 });
        expect(hook.getCurrent().memorySearchUnavailableReason).toBeUndefined();
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-2')]);
    });

    it('never queries a daemon without an explicitly selected usable machine', async () => {
        vi.useFakeTimers();
        withoutSelectedMemoryMachine();
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(daemonRequests()).toEqual([]);
        expect(hook.getCurrent().memorySearchUnavailableReason).toBe('daemon_no_target');
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('reports an unreachable daemon separately from disabled memory search', async () => {
        vi.useFakeTimers();
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MEMORY_SEARCH) {
                throw new Error('Unexpected RPC');
            }
            return {
                ok: false, error: 'machine is offline', errorCode: SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE
            };
        });
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'offline' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 5 });
        expect(hook.getCurrent().memorySearchUnavailableReason).toBe('daemon_unavailable');
        expect(hook.getCurrent().memorySearchUnavailableReason).not.toBe('rpc_error');
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('augments from Home with zero machines and never calls daemon RPC', async () => {
        vi.useFakeTimers();
        withoutSelectedMemoryMachine();
        withReadyHomeSearch();
        seedSessions({ 'session-1': { id: 'session-1', serverId: SERVER_A } });
        daemonReply.mockRejectedValue(new Error('Daemon RPC must not be called for the Home provider'));
        homeReply.mockResolvedValueOnce(result([createMemorySearchHit('session-1')]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(homeReply).toHaveBeenCalledWith(expect.objectContaining({ query: 'vector', serverId: SERVER_A }));
        expect(daemonRequests()).toEqual([]);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-1')]);
        expect(hook.getCurrent().memoryMatchedSessionTargets).toEqual([expect.objectContaining({
                serverId: SERVER_A,
                sessionId: 'session-1', reasons: ['transcript'], sourceMachineId: null
            })]);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('materializes an absent Home hit through the explicit-server reader too', async () => {
        vi.useFakeTimers();
        withoutSelectedMemoryMachine();
        withReadyHomeSearch();
        unavailableSessionIds.add('session-9');
        homeReply.mockResolvedValueOnce(result([createMemorySearchHit('session-9')]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(sessionReadPaths()).toEqual(['/v2/sessions/session-9']);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([]);
    });

    it('keeps an indexing Home off the daemon path and reports its own state', async () => {
        vi.useFakeTimers();
        withoutSelectedMemoryMachine();
        publishSearchFeatures(true);
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(homeReply).not.toHaveBeenCalled();
        expect(daemonRequests()).toEqual([]);
        expect(hook.getCurrent().memorySearchUnavailableReason).toBe('home_unknown');
        await act(async () => publishSearchFeatures(true, { enabled: false, reason: 'indexing' }));
        await hook.rerender({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(homeReply).not.toHaveBeenCalled();
        expect(daemonRequests()).toEqual([]);
        expect(hook.getCurrent().memorySearchUnavailableReason).toBe('home_indexing');
    });

    it('falls back to the explicitly selected machine when Home is not ready', async () => {
        vi.useFakeTimers();
        publishSearchFeatures(true, { enabled: false, reason: 'indexing' });
        seedSessions({ 'session-1': { id: 'session-1', serverId: SERVER_A } });
        daemonReply.mockResolvedValue(result([createMemorySearchHit('session-1')]));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(homeReply).not.toHaveBeenCalled();
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_A, 'session-1')]);
    });

    it('ignores stale Home results after a server switch', async () => {
        vi.useFakeTimers();
        withoutSelectedMemoryMachine();
        withReadyHomeSearch();
        seedSessions({ 'session-1': { id: 'session-1', serverId: SERVER_A }, 'session-2': { id: 'session-2', serverId: SERVER_B } });
        const staleSearch = createDeferred<unknown>();
        let homeSearchCallCount = 0;
        homeReply.mockImplementation(() => ++homeSearchCallCount === 1 ? staleSearch.promise
            : Promise.resolve(result([createMemorySearchHit('session-2', 'Fresh summary')])));
        const hook = await renderMemoryAugmentationHook({ searchQuery: 'vector' });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });
        await act(async () => {
            await focusHome(SERVER_B, 'switch');
        });
        const switched = await hook.rerender({ searchQuery: 'vector' });
        expect([...switched.memoryMatchedSessionKeys]).toEqual([]);
        expect(switched.lastSuccessfulQuery).toBeUndefined();
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect(homeSearchCallCount).toBe(2);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_B, 'session-2')]);
        staleSearch.resolve(result([createMemorySearchHit('session-1', 'Stale summary')]));
        await flushHookEffects({ cycles: 3 });
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual([sessionTagKey(SERVER_B, 'session-2')]);
        expect(hook.getCurrent().lastSuccessfulQuery).toBe('vector');
    });
});
