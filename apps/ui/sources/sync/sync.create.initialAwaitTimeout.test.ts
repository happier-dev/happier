import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { AccountPetLibraryEntryV1Schema } from '@happier-dev/protocol/pets';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { flushHookEffects } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const pet = AccountPetLibraryEntryV1Schema.parse({
    accountPetId: 'pet-1',
    packageFormat: 'codex-compatible-atlas-v1',
    manifest: {
        id: 'blink', displayName: 'Blink', description: 'Built-in compatible pet',
        spritesheetPath: 'spritesheet.webp',
    },
    spritesheetAssetRef: { assetId: 'asset-1', mediaType: 'image/webp', digest: 'sha256:abc', sizeBytes: 3 },
    digest: 'sha256:pkg', sizeBytes: 128, createdAt: 1, updatedAt: 2,
    origin: { kind: 'manualImport' },
});

describe('sync.create initial awaits', () => {
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let home: Awaited<ReturnType<typeof network.addHome>>;
    let stallCore: boolean;
    let petsEnabled: boolean;
    let authPing: 'ready' | 'offline' | 'auth-failed';
    let accountModeUnavailable: boolean;
    let cleanupStateSubscription: (() => void) | undefined;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        stallCore = false;
        petsEnabled = false;
        authPing = 'ready';
        accountModeUnavailable = false;
        cleanupStateSubscription = undefined;
        network = await installSessionOpsNetworkBoundary();
        home = await network.addHome('https://initial-sync.example.test', 'plain-account');
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/auth/ping') {
                if (authPing === 'offline') throw new Error('Network request failed');
                return Response.json({}, { status: authPing === 'auth-failed' ? 401 : 200 });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({ features: { pets: { sync: { enabled: petsEnabled } } } }));
            }
            // Hold genuine HTTP, not an internal queue or cipher owner. Honor
            // transport cancellation so retiring an Account settles its requests.
            if (stallCore && (path === '/v2/account/settings' || path === '/v1/account/profile' || path === '/v1/account/encryption/currentness')) {
                return await new Promise<Response>((_resolve, reject) => {
                    const abort = () => reject(new Error('Test HTTP request aborted'));
                    if (init?.signal?.aborted) abort();
                    else init?.signal?.addEventListener('abort', abort, { once: true });
                });
            }
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return accountModeUnavailable
                // A transient invalid response reaches the mode reader's real
                // backoff; HTTP 503 instead remains in transport supervision.
                ? Response.json({ mode: 'unavailable' })
                : Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v1/account/pets') return Response.json({ ok: true, pets: [pet] });
            if (path === '/v2/sessions') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v1/sessions/active') return Response.json({ sessions: [] });
            if (path === '/v1/machines') return Response.json([]);
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return null;
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
    });

    afterEach(async () => {
        cleanupStateSubscription?.();
        const { syncSwitchServer } = await import('./sync');
        await syncSwitchServer(null);
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        apiSocket.disconnect();
        await network.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    async function finishInitialCreate(credentials: AuthCredentials = { token: home.token }) {
        const { syncCreate } = await import('./sync');
        const pending = syncCreate(credentials);
        await flushHookEffects({ cycles: 8, turns: 2 });
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 2_500 });
        await pending;
        await flushHookEffects({ cycles: 8, turns: 2 });
    }

    it('materializes account pets during initial sync when pets.sync is enabled', async () => {
        petsEnabled = true;
        await finishInitialCreate();

        const { storage } = await import('./domains/state/storage');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect(storage.getState().syncError).toBeNull();
        await expect(getServerFeaturesSnapshot({ serverId: home.id })).resolves.toMatchObject({ status: 'ready' });
        expect(storage.getState().accountPetsById['pet-1']).toMatchObject({
            accountPetId: 'pet-1', digest: 'sha256:pkg',
        });
        const currentnessIndex = network.httpRequests.findIndex(({ url }) => new URL(url).pathname === '/v1/account/encryption/currentness');
        const petsIndex = network.httpRequests.findIndex(({ url }) => new URL(url).pathname === '/v1/account/pets');
        expect(currentnessIndex).toBeGreaterThanOrEqual(0);
        expect(petsIndex).toBeGreaterThan(currentnessIndex);
        expect(network.httpRequests[petsIndex]?.token).toBe(`Bearer ${home.token}`);
    });

    it('does not hang forever waiting for initial sync queues', async () => {
        stallCore = true;
        const { syncCreate, sync } = await import('./sync');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const configure = vi.spyOn(Encryption.prototype, 'configureNativeCryptoWorker');
        const warm = vi.spyOn(Encryption.prototype, 'warmNativeCryptoWorkerForDiagnostics');
        const credentials: AuthCredentials = { token: home.token, secret: encodeBase64(new Uint8Array(32).fill(9), 'base64url') };
        let resolved = false;
        const pending = syncCreate(credentials).then(() => { resolved = true; });
        await flushHookEffects({ cycles: 8, turns: 2 });

        expect(resolved).toBe(false);
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 2_499 });
        expect(resolved).toBe(false);
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 1 });
        expect(resolved).toBe(true);
        await pending;
        expect(sync.encryption).not.toBeNull();
        expect(configure).toHaveBeenCalledWith({
            scope: { accountId: home.accountId, serverId: home.id, generation: 0 },
        });
        expect(warm).toHaveBeenCalledTimes(1);
    });

    it('rebinds the tracking identity when switching to a different authenticated account', async () => {
        stallCore = true;
        const { encodeBase64 } = await import('@/encryption/base64');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { getTrackingAnonymousUserId } = await import('@/track');
        const { sync } = await import('./sync');
        const secretA = new Uint8Array(32).fill(7);
        const secretB = new Uint8Array(32).fill(8);
        const encryptionA = await Encryption.create(secretA);
        const encryptionB = await Encryption.create(secretB);
        const accountA = network.setAccount(home.serverUrl, 'account-a');
        await flushHookEffects({ cycles: 8, turns: 2 });
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 2_500 });
        await accountA;
        await finishInitialCreate({ token: createAccountTokenForTests('account-a'), secret: encodeBase64(secretA, 'base64url') });
        expect(getTrackingAnonymousUserId()).toBe(encryptionA.anonID);

        // The real replacement restores the already-applied Home. Drive the
        // same public initial-sync budget while its HTTP boundary is stalled.
        const accountB = network.setAccount(home.serverUrl, 'account-b');
        await flushHookEffects({ cycles: 8, turns: 2 });
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 2_500 });
        await accountB;
        await sync.switchServer({ token: createAccountTokenForTests('account-b'), secret: encodeBase64(secretB, 'base64url') });

        expect(getTrackingAnonymousUserId()).toBe(encryptionB.anonID);
        expect(sync.getCredentials()?.token).toBe(createAccountTokenForTests('account-b'));
    });

    it('mirrors auth-failed connection state into endpoint connectivity storage', async () => {
        await finishInitialCreate();
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { storage } = await import('./domains/state/storage');
        const { invalidateAllServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        let observed: ManagedConnectionState | undefined;
        cleanupStateSubscription = apiSocket.onConnectionStateChange((state) => { observed = state; });
        authPing = 'auth-failed';

        await invalidateAllServerReachabilitySupervisors();
        await flushHookEffects({ cycles: 8, turns: 2 });

        expect(observed).toMatchObject({ phase: 'auth_failed', reason: 'auth_invalid', nextRetryAt: null });
        expect(storage.getState()).toMatchObject({
            endpointStatus: observed!.phase, endpointReason: observed!.reason,
            endpointAttempt: observed!.attempt, endpointNextRetryAt: observed!.nextRetryAt,
            endpointLastConnectedAt: observed!.lastConnectedAt,
            endpointLastDisconnectedAt: observed!.lastDisconnectedAt,
            endpointLastErrorMessage: observed!.lastErrorMessage,
        });
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/auth/ping').every(({ token }) => token === `Bearer ${home.token}`)).toBe(true);
    });

    it('resumes sync when server reachability returns online after an outage', async () => {
        await finishInitialCreate();
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const { invalidateAllServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const resume = vi.spyOn(sync, 'resumeSync');
        authPing = 'offline';
        await invalidateAllServerReachabilitySupervisors();
        await flushHookEffects({ cycles: 8, turns: 2 });
        expect(storage.getState().endpointStatus).toBe('offline');
        network.httpRequests.length = 0;
        authPing = 'ready';

        // Explicit invalidations coalesce for 250 ms at the reachability owner.
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 250 });
        await invalidateAllServerReachabilitySupervisors();
        await flushHookEffects({ cycles: 8, turns: 2 });

        expect(storage.getState().endpointStatus).toBe('online');
        expect(resume).toHaveBeenCalledWith('server-reachable');
        const recovered = resume.mock.calls.findIndex(([reason]) => reason === 'server-reachable');
        // Resume also awaits bounded ancillary queues; their clock must keep
        // advancing even though this test only serves the core Home routes.
        const { loadSyncTuning } = await import('@/sync/runtime/syncTuning');
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: loadSyncTuning().resumeQuickInvalidateTimeoutMs });
        await resume.mock.results[recovered]?.value;
        expect(network.httpRequests.map(({ url }) => new URL(url).pathname)).toContain('/v2/changes');
    });

    it('starts a token-only plaintext account without constructing account encryption material', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const createEncryption = vi.spyOn(Encryption, 'create');
        const { getTrackingAnonymousUserId } = await import('@/track');
        const { sync } = await import('./sync');

        await finishInitialCreate();

        expect(sync.encryption).toBeNull();
        expect(createEncryption).not.toHaveBeenCalled();
        expect(getTrackingAnonymousUserId()).toBeNull();
        expect(sync.getCredentials()).toEqual({ token: home.token });
        expect(network.socketBoundaries.some(({ token }) => token === home.token)).toBe(true);
        expect(network.httpRequests.map(({ url, token }) => ({ path: new URL(url).pathname, token }))).toContainEqual({
            path: '/v1/account/encryption', token: `Bearer ${home.token}`,
        });
    });

    it.each(['socket-reconnect', 'app-foreground'] as const)('refreshes an unavailable Account mode subscription on %s', async (reason) => {
        await finishInitialCreate();
        const { sync } = await import('./sync');
        const {
            fetchAccountEncryptionMode,
            invalidateAccountEncryptionModeCache,
            getCachedAccountEncryptionMode,
            subscribeAccountEncryptionModeCacheInvalidation,
        } = await import('./api/account/apiAccountEncryptionMode');
        const credentials = sync.getCredentials()!;
        accountModeUnavailable = true;
        invalidateAccountEncryptionModeCache();
        let disclosure: 'plain' | 'e2ee' | null = null;
        let modeReadFailed = false;
        const refresh = () => {
            disclosure = null;
            void fetchAccountEncryptionMode(credentials).then(
                ({ mode }) => { disclosure = mode; },
                () => { disclosure = null; modeReadFailed = true; },
            );
        };
        const unsubscribe = subscribeAccountEncryptionModeCacheInvalidation(refresh);
        try {
            refresh();
            await flushHookEffects({ cycles: 16, turns: 2, advanceTimersMs: 1_000 });
            expect(modeReadFailed).toBe(true);
            expect(disclosure).toBeNull();
            expect(getCachedAccountEncryptionMode(credentials)).toBeNull();
            accountModeUnavailable = false;
            vi.useRealTimers();
            await sync.resumeSync(reason);
            await flushHookEffects({ cycles: 8, turns: 2 });

            expect(disclosure).toBe('plain');
        } finally {
            unsubscribe();
        }
    });
});
