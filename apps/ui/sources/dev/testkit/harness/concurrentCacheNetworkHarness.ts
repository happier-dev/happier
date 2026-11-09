import { expect, vi } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createPlainMachineRowFixture } from '../fixtures/machineFixtures';
import { createPlainSessionCurrentProjectionRecordFixture } from '../fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from './sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { seedPersistedHomeProfilesForTests } from '../fixtures/persistedHomeProfiles';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { createEmptyAccountBootstrapHttpResponse } from '../fixtures/accountBootstrapHttpBoundary';
import { createCompactSessionListFetchBoundary } from './sessionReadBatchHttpBoundary';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

type SessionRow = ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>;
type MachineRow = ReturnType<typeof createPlainMachineRowFixture>;
type HttpResponder = (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;

/** Real secondary-Home cache; only HTTP, Socket.IO and OS credential custody are replaced. */
export async function createConcurrentCacheNetworkHarness(suite: string) {
    const secureValues = new Map<string, string>();
    let readGate: { keys: Set<string>; promise: Promise<void>; release(): void; started: boolean } | null = null;
    let rejectWrites = false;
    const nativePort = {
        invoke: async (command: string, args?: Record<string, unknown>) => {
            const key = String(args?.key);
            if (command === 'desktop_secure_storage_read') {
                if (readGate?.keys.has(key)) { readGate.started = true; await readGate.promise; }
                return secureValues.get(key) ?? null;
            }
            if (command === 'desktop_secure_storage_write') {
                if (rejectWrites) throw new Error('OS credential store refused write');
                secureValues.set(key, String(args?.value)); return null;
            }
            if (command === 'desktop_secure_storage_remove') { secureValues.delete(key); return null; }
            throw new Error(`Unexpected native boundary command: ${command}`);
        },
    };
    vi.stubGlobal('__TAURI_INTERNALS__', nativePort);
    const network = await installSessionOpsNetworkBoundary();
    const bridge = await loadSyncSingletonForTests();
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const cache = await import('@/sync/runtime/orchestration/concurrentSessionCache');
    const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const socketModule = await import('socket.io-client');
    let io = vi.spyOn(socketModule, 'io');
    const featureClient = await import('@/sync/api/capabilities/serverFeaturesClient');
    const originalProfileIds = new Set(profiles.listServerProfiles().map(profile => profile.id));
    const homes = await Promise.all(['a', 'b', 'c'].map(id =>
        network.addHome(`https://${suite}-${id}.example.test`, `account-${id}`)));
    const [homeA, homeB, homeC] = homes;
    const baselineProfiles = profiles.listServerProfiles();
    const sessions = new Map<string, SessionRow[]>();
    const machines = new Map<string, MachineRow[]>();
    let responder: HttpResponder | null = null;
    let focused = false;
    const httpRequests: Array<{ url: URL; init: RequestInit | undefined }> = [];

    async function select(selected = [homeA.id, homeB.id]) {
        await profiles.updateHomeViewState(state => ({ ...state,
            groups: [{ id: suite, name: 'Concurrent Homes', serverIds: selected, presentation: 'grouped' }],
            activeTargetKind: 'group', activeTargetId: suite,
        }));
    }
    const respond: HttpResponder = async (input, init) => {
        const url = new URL(String(input));
        if (responder) {
            const answer = await responder(input, init);
            if (answer) return answer;
        }
        if (url.pathname === '/v2/sessions/read-batch') return null;
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') {
            return Response.json(createRootLayoutFeaturesResponse());
        }
        if (url.pathname === '/v1/account/encryption/currentness') {
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (url.pathname === '/v2/sessions/active' || url.pathname === '/v2/sessions/attention') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        if (url.pathname === '/v2/sessions') {
            return Response.json({ sessions: sessions.get(url.origin) ?? [], nextCursor: null, hasNext: false });
        }
        if (url.pathname.startsWith('/v2/sessions/')) {
            const id = decodeURIComponent(url.pathname.slice('/v2/sessions/'.length));
            const row = sessions.get(url.origin)?.find(row => row.id === id);
            return row ? Response.json({ session: row })
                : Response.json({ error: 'Session not found' }, { status: 404 });
        }
        if (url.pathname === '/v1/machines') return Response.json(machines.get(url.origin) ?? []);
        if (focused) {
            if (url.pathname === '/v1/account/profile') {
                const { profileDefaults } = await import('@/sync/domains/profiles/profile');
                return Response.json({ ...profileDefaults, id: homeA.accountId });
            }
            if (url.pathname === '/v1/artifacts') return Response.json([]);
            if (url.pathname === '/v1/friends' || url.pathname === '/v1/friends/requests') return Response.json({ friends: [], requests: [] });
            if (url.pathname === '/v1/kv') return Response.json({ items: [] });
            if (url.pathname === '/v1/feed') return Response.json({ items: [], hasMore: false });
            if (url.pathname === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            return createEmptyAccountBootstrapHttpResponse(url.pathname, init);
        }
        return null;
    };
    const sessionReads = createCompactSessionListFetchBoundary(respond, { preferExactSnapshot: true });
    const serve: HttpResponder = async (input, init) => {
        httpRequests.push({ url: new URL(String(input)), init });
        return sessionReads(input instanceof Request ? input.url : String(input), init ?? {});
    };
    async function cleanup() {
        readGate?.release(); readGate = null;
        if (focused) {
            await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
            focused = false;
        }
        cache.stopConcurrentSessionCacheSync();
        await pool.resetServerReachabilitySupervisors();
        pool.setServerReachabilityNetworkAllowed(true);
        for (const home of homes) storage.getState().clearSessionListRowsForServerScope(home.id);
    }
    return {
        ...cache, network, profiles, pool, storage, TokenStorage, homeA, homeB, homeC, httpRequests, select,
        get io() { return io; },
        async reset() {
            vi.stubGlobal('__TAURI_INTERNALS__', nativePort);
            await cleanup();
            rejectWrites = false;
            process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
            network.resetRequests();
            io.mockRestore(); io = vi.spyOn(socketModule, 'io');
            featureClient.resetServerFeaturesClientForTests();
            responder = null; sessions.clear(); machines.clear(); httpRequests.length = 0;
            network.setHttpResponder(serve);
            const browserStorage = typeof window !== 'undefined' && typeof document !== 'undefined'
                ? window.localStorage : undefined;
            await seedPersistedHomeProfilesForTests({ profiles: baselineProfiles, activeServerId: homeA.id, browserStorage });
            for (const home of homes) {
                await network.addHome(home.serverUrl, home.accountId);
            }
            await profiles.setActiveServerId(homeA.id, { scope: 'device' });
            const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
            applied.publishAppliedActiveServerSnapshot(profiles.getActiveServerSnapshot(), false);
            await select();
        },
        async cleanup() { await cleanup(); delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT; },
        async dispose() {
            vi.stubGlobal('__TAURI_INTERNALS__', nativePort);
            await cleanup();
            await network.dispose();
            for (const home of homes) if (!originalProfileIds.has(home.id) && profiles.getServerProfileById(home.id)) {
                await profiles.removeServerProfile(home.id);
            }
            io.mockRestore(); bridge.dispose(); vi.unstubAllGlobals();
        },
        setResponder(value: HttpResponder | null) { responder = value; },
        setSessions(home: typeof homeB, rows: SessionRow[]) { sessions.set(home.serverUrl, rows); },
        setMachines(home: typeof homeB, rows: MachineRow[]) { machines.set(home.serverUrl, rows); },
        session: createPlainSessionCurrentProjectionRecordFixture,
        machine(home: typeof homeB, id = 'machine-b'): MachineRow {
            return createPlainMachineRowFixture({ id, accountId: home.accountId });
        },
        requests(path: string) { return httpRequests.filter(request => request.url.pathname === path); },
        socket(home = homeB) {
            const boundary = network.socketBoundaries.slice().reverse().find(boundary => boundary.serverUrl === home.serverUrl);
            expect(boundary).toBeDefined();
            return boundary!;
        },
        async start() {
            cache.startConcurrentSessionCacheSync();
            try {
                await vi.waitFor(() => expect(network.socketBoundaries.some(socket => socket.serverUrl === homeB.serverUrl)).toBe(true));
            } catch (cause) {
                const paths = [...new Set(httpRequests.map(({ url, init }) => `${init?.method ?? 'GET'} ${url.pathname}`))];
                const observation = storage.getState().concurrentSessionListCacheByServerId[homeB.id]?.listObservation;
                throw new Error(`Concurrent Home socket did not start: ${JSON.stringify({ paths, phase: observation?.phase })}`, { cause });
            }
        },
        async startFocused(credentials: AuthCredentials = { token: homeA.token }) {
            focused = true;
            await (await import('@/sync/runtime/orchestration/connectionManager')).restoreConnectionToActiveServer(credentials);
            await (await import('@/sync/runtime/getSyncSingleton')).getSyncSingleton().awaitBootstrapForegroundAcquisition();
            await vi.waitFor(() => expect(storage.getState().profile.id).toBe(homeA.accountId));
            await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
            await (await import('@/sync/runtime/getSyncSingleton')).getSyncSingleton().refreshMachines();
        },
        async ready(home = homeB) {
            await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[home.id]?.listObservation?.phase).toBe('ready'));
            await vi.waitFor(() => expect(storage.getState().machineListStatusByServerId[home.id]).toBe('idle'));
        },
        async refresh(home = homeB) { await cache.refreshConcurrentOrdinarySessionList(home.id); },
        holdCredentialRead(home = homeB) {
            let release!: () => void;
            const promise = new Promise<void>(resolve => { release = resolve; });
            const gate = { keys: new Set([...secureValues].filter(([, value]) => value.includes(home.token)).map(([key]) => key)),
                promise, release, started: false };
            readGate = gate;
            return gate;
        },
        rejectCredentialWrites(value: boolean) { rejectWrites = value; },
    };
}
