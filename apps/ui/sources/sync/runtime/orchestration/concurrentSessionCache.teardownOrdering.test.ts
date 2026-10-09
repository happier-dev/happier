import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';

// Native UI and cryptography adapters do not exist in this Node host.
vi.mock('react-native', async () => {
    const { createReactNativeWebRuntime } = await import('@/dev/testkit/runtime/reactNativeRuntime');
    return createReactNativeWebRuntime(undefined, () => vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub'));
});
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-updates', async () => (await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock());
vi.mock('react-native-typography', async () => (await import('@/dev/testkit/mocks/reactNativeTypography')).createReactNativeTypographyMock());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());

// Compile the real app graph before case-local credentials, clocks and held IO.
// Each case still restores its own canonical Sync namespace after resetModules.
installDisconnectedServerSocketBoundary();
const initialSync = await loadSyncSingletonForTests();
initialSync.dispose();

let cleanup: (() => Promise<void>) | null = null;

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('self', globalThis);
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
});
afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('concurrent session cache teardown ordering', () => {
    it.each(['retain', 'replace', 'remove'] as const)('preserves same-Account transfer data and withdraws retired credentials (%s)', async (credentialMutation) => {
        const network = await installSessionOpsNetworkBoundary();
        const homeA = await network.addHome('https://teardown-a.example.test', 'account-a');
        const homeB = await network.addHome('https://teardown-b.example.test', 'account-b');
        const profiles = await import('@/sync/domains/server/serverProfiles');
        await profiles.setActiveServerId(homeA.id, { scope: 'device' });
        await profiles.updateHomeViewState((state) => ({
            ...state,
            groups: [{ id: 'main', name: 'Main', serverIds: [homeA.id, homeB.id], presentation: 'grouped' }],
            activeTargetKind: 'group', activeTargetId: 'main',
        }));

        const sockets: Array<ReturnType<typeof createSocketIoBoundaryStub> & { endpoint: string; purpose: unknown }> = [];
        vi.doMock('socket.io-client', async (importOriginal) => ({
            ...await importOriginal<typeof import('socket.io-client')>(),
            io: (endpoint: string, options: { auth?: { clientPurpose?: unknown } }) => {
                const boundary = createSocketIoBoundaryStub();
                // A network adapter can still deliver a disconnect while being
                // closed. The real transport/cache must detach its observers.
                boundary.socket.disconnect.mockImplementation(() => boundary.trigger('disconnect', 'transport close'));
                sockets.push({ ...boundary, endpoint, purpose: options.auth?.clientPurpose });
                return boundary.socket;
            },
        }));

        let holdIncomingSecrets = false;
        const heldSecrets: { finish: (() => void) | null } = { finish: null };
        const values = new Map<string, string>();
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: async (command: string, args?: Record<string, unknown>) => {
                const key = String(args?.key);
                if (command === 'desktop_secure_storage_read') {
                    if (key.startsWith('device-local-settings-secret-key:v1')) {
                        if (holdIncomingSecrets) await new Promise<void>((resolve) => { heldSecrets.finish = resolve; });
                        return JSON.stringify({ v: 1, key: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') });
                    }
                    return values.get(key) ?? null;
                }
                if (command === 'desktop_secure_storage_write') { values.set(key, String(args?.value)); return null; }
                if (command === 'desktop_secure_storage_remove') { values.delete(key); return null; }
                throw new Error(`Unexpected native command: ${command}`);
            },
        });
        // Exercise the real credential parser/mutation owner through the native
        // store, not the network harness's fixed saved-Home credential shortcut.
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        for (const home of [homeA, homeB]) {
            await expect(TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
                token: home.token,
            })).resolves.toBe(true);
        }
        const machineRow = createPlainMachineRowFixture({ id: 'machine-b', accountId: homeB.accountId });
        network.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            const path = url.pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/sessions') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v1/machines') return Response.json(
                url.origin === homeB.serverUrl && new Headers(init?.headers).get('authorization') === `Bearer ${homeB.token}`
                    ? [machineRow] : [],
            );
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], cursor: 0, hasMore: false });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            return null;
        });
        await loadSyncSingletonForTests();
        const connection = await import('./connectionManager');
        const cache = await import('./concurrentSessionCache');
        const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { storage } = await import('@/sync/domains/state/storageStore');
        let observer: Awaited<ReturnType<typeof pool.acquireServerReachabilitySupervisor>> | null = null;
        cleanup = async () => {
            holdIncomingSecrets = false;
            heldSecrets.finish?.();
            cache.stopConcurrentSessionCacheSync();
            await observer?.release();
            await connection.disconnectActiveServerConnection();
            await pool.resetServerReachabilitySupervisors();
            network.dispose();
            vi.doUnmock('socket.io-client');
            for (const home of [homeB, homeA]) await profiles.removeServerProfile(home.id);
        };
        await connection.restoreConnectionToActiveServer({ token: homeA.token });
        expect(connection.getAppliedActiveServerId()).toBe(homeA.id);
        cache.startConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(cache.isConcurrentSessionListQueryHomeOnline(homeB.id)).toBe(true));
        const secondaryB = sockets.find((socket) => socket.endpoint === homeB.serverUrl && socket.purpose === 'concurrent-server-cache');
        expect(secondaryB).toBeDefined();
        observer = await pool.acquireServerReachabilitySupervisor({ serverUrl: homeB.serverUrl, token: homeB.token });
        const row = createSessionListRenderableSessionFixture({ id: 'session-b' });
        storage.getState().applyServerScopedSessionListRows(homeB.id, [row], { source: 'ordinary', mode: 'replace' });
        const machine = createMachineFixture({ id: 'machine-b' });
        storage.setState((state) => ({ machineListByServerId: { ...state.machineListByServerId, [homeB.id]: [machine] } }));
        // Queue a genuine profile notification, then switch through the real
        // focused owner. Hold only the incoming device-store read, after Sync
        // has withdrawn its outgoing singleton and emitted "applying B".
        await profiles.upsertServerProfile({ serverUrl: homeB.serverUrl, name: 'Renamed B' });
        holdIncomingSecrets = true;
        await profiles.setActiveServerId(homeB.id, { scope: 'device' });
        const switching = connection.switchConnectionToActiveServer();
        await vi.waitFor(() => expect(heldSecrets.finish).toBeTypeOf('function'));
        await vi.advanceTimersByTimeAsync(1);

        expect(connection.getAppliedActiveServerId()).toBe(homeA.id);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(false);
        expect(cache.isConcurrentOrdinarySessionListHome(homeA.id)).toBe(true);
        expect(cache.isConcurrentOrdinarySessionListHome(homeB.id)).toBe(false);
        expect(storage.getState().ordinarySessionListMembershipByServerId[homeB.id]).toEqual(['session-b']);
        expect(storage.getState().machineListByServerId[homeB.id]?.map((m) => m.id)).toEqual(['machine-b']);
        expect(secondaryB!.socket.disconnect).toHaveBeenCalled();
        // The retained observer keeps reachability online. A teardown callback
        // mistakenly reported as a live failure would move this real pool offline.
        expect(pool.peekServerReachabilityState(homeB.serverUrl, homeB.token)?.phase).toBe('online');
        secondaryB!.trigger('disconnect', 'late transport close');
        expect(pool.peekServerReachabilityState(homeB.serverUrl, homeB.token)?.phase).toBe('online');

        if (credentialMutation !== 'retain') {
            if (credentialMutation === 'replace') {
                await expect(TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, {
                    token: createAccountTokenForTests('replacement-account'),
                })).resolves.toBe(true);
            } else {
                await expect(TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).resolves.toBe(true);
            }
            // Transfer retention is not authority to disclose the old Account
            // after its credential changes, even while the singleton is held.
            expect(storage.getState().ordinarySessionListMembershipByServerId[homeB.id] ?? []).toEqual([]);
            expect(storage.getState().sessionListRowsByServerId[homeB.id]?.['session-b']).toBeUndefined();
            expect(storage.getState().machineListByServerId[homeB.id] ?? []).toEqual([]);
            holdIncomingSecrets = false;
            heldSecrets.finish!();
            // This case owns synchronous withdrawal, not a retired bootstrap's
            // later recovery outcome. Cleanup still joins its real promise.
            await switching.catch(() => undefined);
            return;
        }
        await expect(TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, {
            token: homeB.token,
        })).resolves.toBe(true);
        expect(storage.getState().ordinarySessionListMembershipByServerId[homeB.id]).toEqual(['session-b']);
        expect(storage.getState().machineListByServerId[homeB.id]?.map((m) => m.id)).toEqual(['machine-b']);

        holdIncomingSecrets = false;
        heldSecrets.finish!();
        await switching;
        await vi.advanceTimersByTimeAsync(1);
        expect(connection.getAppliedActiveServerId()).toBe(homeB.id);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        expect(cache.isConcurrentOrdinarySessionListHome(homeA.id)).toBe(true);
        expect(cache.isConcurrentOrdinarySessionListHome(homeB.id)).toBe(false);
        expect(sockets.filter((socket) => socket.endpoint === homeB.serverUrl && socket.purpose === 'concurrent-server-cache')).toHaveLength(1);

        cache.stopConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);
        expect(pool.peekServerReachabilityState(homeB.serverUrl, homeB.token)?.phase).toBe('online');
    });
});
