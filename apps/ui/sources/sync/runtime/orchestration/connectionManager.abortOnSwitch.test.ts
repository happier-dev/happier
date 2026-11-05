import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import tweetnacl from 'tweetnacl';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { encodeBase64 } from '@/encryption/base64';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Observe cold startup before loading Sync or a Home harness. Prepare the real
// graph during collection, like static imports, so transform cost is not part
// of a connection-lifecycle test's setup hook.
async function observeColdStartup() {
    const connection = await import('./connectionManager');
    const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    const locks = installWebLockManagerMock();
    const { upsertServerProfile, setActiveServerId, removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const home = await upsertServerProfile({ name: 'Restored Home', serverUrl: 'https://restored.example.test' });
    try {
        await setActiveServerId(home.id);
        const selected = getActiveServerSnapshot();
        return {
            appliedId: connection.getAppliedActiveServerId(),
            applied: connection.getAppliedActiveServerSnapshot(),
            expected: { serverId: home.id, serverUrl: home.serverUrl, generation: selected.generation },
        };
    } finally {
        await removeServerProfile(home.id);
        locks.restore();
    }
}
const startup = await observeColdStartup();
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createHomeGovernanceHarness } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
const connection = await import('./connectionManager');
const runtime = await import('@/sync/domains/server/serverRuntime');
const scope = await import('@/sync/domains/scope/activeServerAccountScope');

describe('applied active Home snapshot', () => {
    it('resolves the applied Home when it is first read, not when the module is imported', () => {
        expect(startup.appliedId).toBe(startup.expected.serverId);
        expect(startup.applied).toEqual(startup.expected);
    });
});

describe('switchConnectionToActiveServer', () => {
    const releases = new Set<() => void>();
    const subscriptions = new Set<() => void>();
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;

    beforeEach(async () => {
        // Desktop secure custody is asynchronous even for already-cached
        // credentials; hold its real storage port to exercise the read race.
        vi.stubGlobal('__TAURI_INTERNALS__', createDesktopSecureStorageBoundary());
        await homes.reset();
    });

    afterEach(async () => {
        for (const release of releases) release();
        releases.clear();
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions.clear();
        await connection.disconnectActiveServerConnection();
        await homes.reset();
        browser?.restore();
        browser = undefined;
        vi.restoreAllMocks();
    });

    async function addHome(name: string, accountId: string | null = `account-${name}`) {
        const serverUrl = `https://${name}.example.test`;
        const serverId = await homes.addHome({ name, serverUrl, accountId, active: false });
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        return { serverId, serverUrl, accountId, credentials: accountId ? { token: createAccountTokenForTests(accountId) } : null };
    }

    async function selectHome(home: Awaited<ReturnType<typeof addHome>>) {
        await runtime.setActiveServer({ serverId: home.serverId });
        return runtime.getActiveServerSnapshot();
    }

    async function restoreHome(home: Awaited<ReturnType<typeof addHome>>) {
        if (!home.credentials) throw new Error('A restored Home needs a signed-in Account');
        await selectHome(home);
        await connection.restoreConnectionToActiveServer(home.credentials);
    }

    it('settles without Account authority or Home requests before Home setup and after removing a signed-out Home', async () => {
        await seedPersistedHomeProfilesForTests({ profiles: [], activeServerId: '' });
        expect(runtime.getActiveServerSnapshot()).toMatchObject({ serverId: '', serverUrl: '' });
        expect(await connection.switchConnectionToActiveServer()).toBeNull();
        expect(scope.getActiveServerAccountScope()).toBeNull();
        expect(homes.requests).toHaveLength(0);

        const signedOut = await addHome('signed-out-first-run', null);
        await selectHome(signedOut);
        expect(await connection.switchConnectionToActiveServer()).toBeNull();
        expect(connection.getAppliedActiveServerId()).toBe(signedOut.serverId);
        expect(scope.getActiveServerAccountScope()).toBeNull();
        expect(homes.requests).toHaveLength(0);

        const { removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
        await removeServerProfile(signedOut.serverId);
        expect(runtime.getActiveServerSnapshot()).toMatchObject({ serverId: '', serverUrl: '' });
        expect(await connection.switchConnectionToActiveServer()).toBeNull();
        expect(connection.getAppliedActiveServerId()).toBe('');
        expect(scope.getActiveServerAccountScope()).toBeNull();
        expect(homes.requests).toHaveLength(0);
    });

    async function holdDeviceRead(matches: (key: string) => boolean) {
        const deviceStorage = await import('@/auth/storage/deviceLocalStorage');
        const read = deviceStorage.readDeviceLocalStorageString;
        const started = createDeferred<void>();
        const released = createDeferred<void>();
        let held = false;
        // Device-local storage is an external persistence port. The credential,
        // settings-key, Account and Sync owners above it all remain real.
        vi.spyOn(deviceStorage, 'readDeviceLocalStorageString').mockImplementation(async (key) => {
            if (matches(key)) {
                if (!held) {
                    held = true;
                    started.resolve();
                }
                // A bootstrap read can reach the same port first. Keep every
                // matching read held so it cannot let the operation under test
                // bypass the boundary before selection changes.
                await released.promise;
            }
            return await read(key);
        });
        const release = () => released.resolve();
        releases.add(release);
        return { started: started.promise, release };
    }

    it('uses server-scoped credentials for the active server when switching sync server', async () => {
        const homeA = await addHome('a');
        await addHome('b');
        const selected = await selectHome(homeA);
        const result = await connection.switchConnectionToActiveServer();
        expect(result).toEqual(homeA.credentials);
        expect(scope.getActiveServerAccountScope()).toEqual({ serverId: homeA.serverId, accountId: homeA.accountId });
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(expect.objectContaining({
            serverId: homeA.serverId, serverUrl: homeA.serverUrl, generation: selected.generation,
        }));
        homes.answer(homeA.serverId, '/v1/scoped-probe', { body: { ok: true } });
        const { serverFetch } = await import('@/sync/http/client');
        await serverFetch('/v1/scoped-probe', undefined, { retry: 'none' });
        expect(homes.requestsFor('/v1/scoped-probe')).toEqual([
            expect.objectContaining({ serverId: homeA.serverId, token: homeA.credentials?.token }),
        ]);
    });

    it('aborts in-flight server fetches before switching sync server', async () => {
        const homeA = await addHome('a');
        const homeB = await addHome('b');
        await restoreHome(homeA);
        const entered = createDeferred<void>();
        const released = createDeferred<void>();
        releases.add(() => released.resolve());
        let requestSignal: AbortSignal | null | undefined;
        homes.answer(homeA.serverId, '/v1/held-request', {
            select: (_input, request) => {
                requestSignal = request.signal;
                entered.resolve();
                return { body: {}, respondAfter: released.promise };
            },
        });
        const { serverFetch, StaleServerGenerationError } = await import('@/sync/http/client');
        const result = serverFetch('/v1/held-request', undefined, { includeAuth: false, retry: 'none' }).catch(error => error);
        await entered.promise;
        let abortedBeforeSyncApplication = false;
        subscriptions.add(connection.subscribeApplyingActiveServer(serverId => {
            if (serverId === homeB.serverId) abortedBeforeSyncApplication = requestSignal?.aborted === true;
        }));
        await selectHome(homeB);
        await connection.switchConnectionToActiveServer();
        expect(abortedBeforeSyncApplication).toBe(true);
        expect(await result).toBeInstanceOf(StaleServerGenerationError);
        expect(scope.getActiveServerAccountScope()).toEqual({ serverId: homeB.serverId, accountId: homeB.accountId });
    });

    it('applies latest server generation after a switch happens during an in-flight switch', async () => {
        const homeA = await addHome('a');
        const homeB = await addHome('b');
        await restoreHome(homeA);
        await selectHome(homeA);
        const gate = await holdDeviceRead(key => key.startsWith('device-local-settings-secret-key:v1:'));
        const first = connection.switchConnectionToActiveServer();
        await gate.started;
        const latest = await selectHome(homeB);
        const second = connection.switchConnectionToActiveServer();
        gate.release();
        await expect(first).resolves.toEqual(homeB.credentials);
        await expect(second).resolves.toEqual(homeB.credentials);
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(expect.objectContaining({
            serverId: homeB.serverId, generation: latest.generation,
        }));
        expect(scope.getActiveServerAccountScope()).toEqual({ serverId: homeB.serverId, accountId: homeB.accountId });
    });

    it('does not return stale credentials when a newer Home is requested during the already-applied credential read', async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://connection-switch.test' });
        const homeA = await addHome('a');
        const homeB = await addHome('b');
        await restoreHome(homeA);
        const applied = connection.getAppliedActiveServerSnapshot();
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(applied);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        const gate = await holdDeviceRead(key => key.startsWith('auth_credentials'));
        const alreadyAppliedRead = connection.switchConnectionToActiveServer();
        await Promise.race([gate.started, alreadyAppliedRead.then(() => {
            throw new Error('Credential lookup returned before reaching its platform boundary');
        })]);
        // A real tab selection does not wait for the device-wide mutation lock.
        await runtime.setActiveServer({ serverId: homeB.serverId, scope: 'tab' });
        const latest = runtime.getActiveServerSnapshot();
        expect(latest.serverId).toBe(homeB.serverId);
        const newerRequest = connection.switchConnectionToActiveServer();
        gate.release();
        await expect(alreadyAppliedRead).resolves.toEqual(homeB.credentials);
        await expect(newerRequest).resolves.toEqual(homeB.credentials);
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(expect.objectContaining({
            serverId: homeB.serverId, serverUrl: homeB.serverUrl, generation: latest.generation,
        }));
    });

    it('publishes a same-Home applied event when its connection generation changes', async () => {
        const home = await addHome('a');
        await restoreHome(home);
        const originalGeneration = connection.getAppliedActiveServerSnapshot().generation;
        const applied: Array<{ serverId: string; generation: number }> = [];
        subscriptions.add(connection.subscribeAppliedActiveServer((serverId, generation) => applied.push({ serverId, generation })));
        const latest = await selectHome(home);
        expect(latest.generation).toBeGreaterThan(originalGeneration);
        await connection.switchConnectionToActiveServer();
        expect(applied).toEqual([{ serverId: home.serverId, generation: latest.generation }]);
    });

    it('republishes the same Home when its singleton transport becomes available again', async () => {
        const home = await addHome('a');
        await restoreHome(home);
        const applied: string[] = [];
        const availability: boolean[] = [];
        subscriptions.add(connection.subscribeAppliedActiveServer(serverId => applied.push(serverId)));
        subscriptions.add(connection.subscribeAppliedActiveServerRuntimeAvailability(available => availability.push(available)));
        await connection.restoreConnectionToActiveServer(home.credentials!);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        expect(scope.getActiveServerAccountScope()).toEqual({ serverId: home.serverId, accountId: home.accountId });
        expect(applied).toEqual([]);
        expect(availability).toEqual([false, true]);
    });

    it('keeps the retained Home unavailable after its singleton transport is disconnected', async () => {
        const home = await addHome('a');
        await restoreHome(home);
        const applied = connection.getAppliedActiveServerSnapshot();
        const lifetime = scope.captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        await connection.disconnectActiveServerConnection();
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(applied);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(false);
        expect(scope.getActiveServerAccountScope()).toBeNull();
        expect(lifetime?.isCurrent()).toBe(false);
    });

    it('restores a disconnected Home at the same generation before reusing its applied shortcut', async () => {
        const home = await addHome('a');
        await restoreHome(home);
        const applied = connection.getAppliedActiveServerSnapshot();
        const retired = scope.captureActiveServerAccountScopeLifetime();
        await connection.disconnectActiveServerConnection();
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(false);
        await connection.retryActiveServerConnection();
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(applied);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        expect(scope.getActiveServerAccountScope()).toEqual({ serverId: home.serverId, accountId: home.accountId });
        expect(scope.captureActiveServerAccountScopeLifetime()).not.toBe(retired);
        expect(retired?.isCurrent()).toBe(false);
    });

    it('starts Sync with the new credential when the same Home is signed into after a signed-out apply', async () => {
        const home = await addHome('a', null);
        const selected = await selectHome(home);
        await expect(connection.switchConnectionToActiveServer()).resolves.toBeNull();
        expect(scope.getActiveServerAccountScope()).toBeNull();
        await homes.switchAccount(home.serverId, 'account-a');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const credentials = { token: createAccountTokenForTests('account-a') };
        await expect(connection.switchConnectionToActiveServer()).resolves.toEqual(credentials);
        expect(runtime.getActiveServerSnapshot().generation).toBe(selected.generation);
        expect(scope.getActiveServerAccountScope()).toEqual({ serverId: home.serverId, accountId: 'account-a' });
        const lifetime = scope.captureActiveServerAccountScopeLifetime();
        await expect(connection.switchConnectionToActiveServer()).resolves.toEqual(credentials);
        expect(scope.captureActiveServerAccountScopeLifetime()).toBe(lifetime);
        expect(lifetime?.isCurrent()).toBe(true);
    });

    it('retires Sync when the same Home signs out, and restarts it for the next credential', async () => {
        const home = await addHome('a');
        await restoreHome(home);
        const generation = runtime.getActiveServerSnapshot().generation;
        const retired = scope.captureActiveServerAccountScopeLifetime();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId })).toBe(true);
        await expect(connection.switchConnectionToActiveServer()).resolves.toBeNull();
        expect(scope.getActiveServerAccountScope()).toBeNull();
        expect(retired?.isCurrent()).toBe(false);
        await homes.switchAccount(home.serverId, 'account-a2');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await expect(connection.switchConnectionToActiveServer()).resolves.toEqual({ token: createAccountTokenForTests('account-a2') });
        expect(runtime.getActiveServerSnapshot().generation).toBe(generation);
        expect(scope.getActiveServerAccountScope()).toEqual({ serverId: home.serverId, accountId: 'account-a2' });
    });

    it('publishes only the focused Home whose full Sync application has completed', async () => {
        const homeA = await addHome('a');
        const homeB = await addHome('b');
        await restoreHome(homeA);
        const retained = connection.getAppliedActiveServerSnapshot();
        await selectHome(homeA);
        const gate = await holdDeviceRead(key => key.startsWith('device-local-settings-secret-key:v1:'));
        const applied: string[] = [];
        const applying: string[] = [];
        subscriptions.add(connection.subscribeAppliedActiveServer(serverId => applied.push(serverId)));
        subscriptions.add(connection.subscribeApplyingActiveServer(serverId => applying.push(serverId)));
        const first = connection.switchConnectionToActiveServer();
        await gate.started;
        const latest = await selectHome(homeB);
        const second = connection.switchConnectionToActiveServer();
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(retained);
        expect(applied).toEqual([]);
        expect(applying).toEqual([homeA.serverId]);
        gate.release();
        await Promise.all([first, second]);
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(expect.objectContaining({ serverId: homeB.serverId, generation: latest.generation }));
        expect(applied).toEqual([homeB.serverId]);
        expect(applying).toEqual([homeA.serverId, homeB.serverId]);
    });

    it('withdraws the singleton transport before the former applied Home is reset for a new target', async () => {
        const homeA = await addHome('a');
        const homeB = await addHome('b');
        await restoreHome(homeA);
        const retained = connection.getAppliedActiveServerSnapshot();
        await selectHome(homeB);
        const gate = await holdDeviceRead(key => key.startsWith('device-local-settings-secret-key:v1:'));
        const pendingSwitch = connection.switchConnectionToActiveServer();
        await gate.started;
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(retained);
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(false);
        const queryRuntime = await import('@/sync/domains/session/listing/sessionListQueryRuntime');
        expect(queryRuntime.isSyncOwnedOrdinarySessionListHome(homeA.serverId)).toBe(false);
        expect(queryRuntime.isSyncOwnedOrdinarySessionListHome(homeB.serverId)).toBe(false);
        const targetSessionRequests = () => homes.requests.filter(request => request.serverId === homeB.serverId
            && request.path.startsWith('/v2/sessions'));
        expect(targetSessionRequests()).toEqual([]);
        // A staged/applying Home is withdrawn from concurrent ownership too;
        // the real query owner reports unavailability rather than borrowing Sync.
        await expect(queryRuntime.fetchSessionListQueryPageForHome(homeB.serverId, {
            source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
            membership: 'ordinary', signal: new AbortController().signal,
        })).rejects.toMatchObject({ code: 'home_unavailable' });
        expect(targetSessionRequests()).toEqual([]);
        gate.release();
        await pendingSwitch;
        expect(connection.getAppliedActiveServerSnapshot()).toEqual(expect.objectContaining({ serverId: homeB.serverId }));
        expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
    });

    it('reapplies valid E2EE material when the same Account bearer changes its content key', async () => {
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const token = createAccountTokenForTests('account-a');
        const credentialsFor = (seed: number) => {
            const pair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(seed));
            const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
                material: { type: 'dataKey', machineKey: pair.secretKey }, dataKeyPublicKey: pair.publicKey });
            return { credentials: { token, encryption: { publicKey: encodeBase64(pair.publicKey), machineKey: encodeBase64(pair.secretKey) } },
                fingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) };
        };
        const original = credentialsFor(7);
        const refreshed = credentialsFor(8);
        let binding = original;
        const mode = createDeferred<void>();
        let holdMode = false;
        const serverId = await homes.addHome({ name: 'material', serverUrl: 'https://material.example.test',
            accountId: 'account-a', credentials: original.credentials, accountEncryptionMode: 'e2ee' });
        homes.answer(serverId, '/v1/account/encryption', { body: { mode: 'e2ee', updatedAt: 1 },
            select: () => holdMode ? { body: { mode: 'e2ee', updatedAt: 1 }, respondAfter: mode.promise } : undefined });
        homes.answer(serverId, '/v1/account/encryption/currentness', { select: () => ({ body: { mode: 'e2ee', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: binding.fingerprint, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'available' } } }) });
        homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: ProjectAccountRowListResponseV1Schema.parse({
            status: 'listed', coverage: 'complete', rows: [],
        }) });
        await runtime.setActiveServer({ serverId });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const home = (await import('@/sync/domains/server/serverProfiles')).getServerProfileById(serverId)!;
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId }, original.credentials)).toBe(true);
        await connection.switchConnectionToActiveServer();
        const { storage } = await import('@/sync/domains/state/storage');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' });
        const lifetime = scope.captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected current E2EE Account owner');
        binding = refreshed;
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId }, refreshed.credentials)).toBe(true);
        holdMode = true;
        const switching = connection.switchConnectionToActiveServer();
        try {
            await flushHookEffects({ cycles: 30 });
            expect(lifetime.isCurrent()).toBe(false);
            mode.resolve();
            expect(await switching).toEqual(refreshed.credentials);
            expect(connection.isAppliedActiveServerRuntimeAvailable()).toBe(true);
        } finally {
            mode.resolve();
            await switching;
        }
    });
});
