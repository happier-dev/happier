import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import {
    homeProfileForTests,
    installTokenStorageTestIsolation,
    installTokenStorageWebPlatformMocks,
} from './tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from './tokenStorage.web.testHelpers';
import type { HomeCredentialMutationEvent, LegacyAuthCredentials, DataKeyAuthCredentials } from './tokenStorage';
import nacl from 'tweetnacl';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('token_storage_server_scoped');

const { TokenStorage, subscribeHomeCredentialMutations } = await import('./tokenStorage');
const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
const { getActiveServerUrl, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { withHomeMutationAuthority } = await import('@/sync/domains/server/homeMutationLock');
const { digest } = await import('@/platform/digest');
const { encodeBase64 } = await import('@/encryption/base64');
const { readStorageScopeFromEnv, scopedStorageId } = await import('@/utils/system/storageScope');

describe('TokenStorage (web) server-scoped credentials', () => {
    let restoreLocalStorage: (() => void) | null = null;
    let restoreWebLocks: (() => void) | null = null;

    beforeEach(() => {
        restoreWebLocks = installWebLockManagerMock().restore;
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        restoreWebLocks?.();
        restoreWebLocks = null;
    });

    it('retains genuine same-Account history on refresh while exact replacement can forget it', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;
        const token = (sub: string, nonce: string) => `e30.${Buffer.from(JSON.stringify({ sub, nonce })).toString('base64url')}.sig`;
        const endpoint = 'https://historical-storage.test';
        const target = { serverId: 'srv_historical_storage' };
        const original = { token: token('alice', 'old'), secret: encodeBase64(new Uint8Array(32).fill(8), 'base64url') };
        await TokenStorage.setCredentialsForServerUrl(endpoint, target, original);
        const next = { token: token('alice', 'new') };
        await TokenStorage.setCredentialsForServerUrl(endpoint, { ...target, preserveHistoricalEncryption: true }, next);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual({ ...original, ...next });
        await TokenStorage.setCredentialsForServerUrl(endpoint, target, next);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(next);
        await TokenStorage.setCredentialsForServerUrl(endpoint, target, original);
        const other = { token: token('bob', 'new') };
        await TokenStorage.setCredentialsForServerUrl(endpoint, { ...target, preserveHistoricalEncryption: true }, other);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(other);
        await TokenStorage.setCredentialsForServerUrl(endpoint, target, original);
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, { ...target, preserveHistoricalEncryption: true }, { token: 'unknown-identity' })).toBe(false);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(original);
    });

    it.each([['legacy', 'legacy'], ['dataKey', 'dataKey'], ['dataKey', 'legacy']] as const)('keeps an active %s pin on implicit %s restore while explicit custody changes still work', async (kind, incomingKind) => {
        restoreLocalStorage = installLocalStorageMock().restore;
        const token = (sub: string, nonce: string) => `e30.${Buffer.from(JSON.stringify({ sub, nonce })).toString('base64url')}.sig`;
        const endpoint = 'https://active-custody-storage.test';
        const target = { serverId: 'srv_active_custody_storage', preserveHistoricalEncryption: true };
        const key = new Uint8Array(32).fill(251);
        const publicKey = nacl.box.keyPair.fromSecretKey(key).publicKey;
        const material = (kind: 'legacy' | 'dataKey', encoding: 'base64' | 'base64url') => kind === 'legacy'
            ? { secret: encodeBase64(key, encoding) }
            : { encryption: { machineKey: encodeBase64(key, encoding), publicKey: encodeBase64(publicKey, encoding) } };
        const active: LegacyAuthCredentials | DataKeyAuthCredentials = { token: token('alice', 'old'), ...material(kind, 'base64url') };
        const restored = { token: token('alice', 'restored'), ...material(incomingKind, 'base64'), custody: 'historical' as const };
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, target, active)).toBe(true);
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, target, restored)).toBe(true);
        const retained = { ...active, token: restored.token };
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(retained);

        // Keep-key and post-conversion writes carry the exact prior credential.
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, { ...target, expectedCredentials: retained }, restored)).toBe(true);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(restored);
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, { ...target, expectedCredentials: restored }, active)).toBe(true);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(active);

        // A different Account and a signed-out device have no same-Account pin.
        const other = { ...restored, token: token('bob', 'restored') };
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, target, other)).toBe(true);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(other);
        expect(await TokenStorage.removeCredentialsForServerUrl(endpoint, target)).toBe(true);
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, target, restored)).toBe(true);
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual(restored);
    });

    it('restores the previous exact credential bytes after an admitted write', async () => {
        const local = installLocalStorageMock();
        restoreLocalStorage = local.restore;
        const endpoint = 'https://rollback-storage.test';
        const target = { serverId: 'srv_rollback_storage' };
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, target, { token: 'previous' })).toBe(true);
        const before = new Map(local.store);
        const receipt = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint, target, { token: 'candidate' });
        if (!receipt) throw new Error('Expected admitted credential write');
        expect(await receipt.rollback()).toBe(true);
        expect(local.store).toEqual(before);
        local.setItemMock.mockClear();
        local.removeItemMock.mockClear();
        expect(await receipt.rollback()).toBe(true);
        expect(local.store).toEqual(before);
        expect(local.setItemMock).not.toHaveBeenCalled();
        expect(local.removeItemMock).not.toHaveBeenCalled();
    });

    it.each(['read', 'remove', 'restore'] as const)('surfaces an actual rollback storage %s failure', async (operation) => {
        const local = installLocalStorageMock();
        restoreLocalStorage = local.restore;
        const endpoint = 'https://rollback-storage-failure.test';
        const target = { serverId: 'srv_rollback_storage_failure' };
        if (operation === 'restore') {
            expect(await TokenStorage.setCredentialsForServerUrl(endpoint, target, { token: 'previous' })).toBe(true);
        }
        const receipt = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint, target, { token: 'candidate' });
        if (!receipt) throw new Error('Expected admitted credential write');
        const beforeRollback = new Map(local.store);
        const failure = new Error('Device credential storage unavailable');
        if (operation === 'read') local.getItemMock.mockImplementation(() => { throw failure; });
        if (operation === 'remove') local.removeItemMock.mockImplementation(() => { throw failure; });
        if (operation === 'restore') local.setItemMock.mockImplementation(() => { throw failure; });
        await expect(receipt.rollback()).rejects.toBe(failure);
        expect(local.store).toEqual(beforeRollback);
    });

    it('does not write during rollback when a newer same-scope writer owns the credential', async () => {
        const local = installLocalStorageMock();
        restoreLocalStorage = local.restore;
        const endpoint = 'https://rollback-successor.test';
        const target = { serverId: 'srv_rollback_successor' };
        const receipt = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint, target, { token: 'candidate' });
        if (!receipt) throw new Error('Expected admitted credential write');
        expect(await TokenStorage.setCredentialsForServerUrl(endpoint, target, { token: 'successor' })).toBe(true);
        const beforeRollback = new Map(local.store);
        local.setItemMock.mockClear();
        local.removeItemMock.mockClear();
        expect(await receipt.rollback()).toBe(false);
        expect(await receipt.rollback()).toBe(false);
        expect(local.store).toEqual(beforeRollback);
        expect(local.setItemMock).not.toHaveBeenCalled();
        expect(local.removeItemMock).not.toHaveBeenCalled();
        expect(await TokenStorage.getCredentialsForServerUrl(endpoint, target)).toEqual({ token: 'successor' });
    });

    it('keeps credentials separate per server URL', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;


        await setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        await setServerUrl('https://server-b.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

        await setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-a', secret: 'secret-a' });

        await setServerUrl('https://server-b.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-b', secret: 'secret-b' });
    });

    it('reads a profile-id-scoped credential only while that profile is the focused Home', async () => {
        const local = installLocalStorageMock();
        restoreLocalStorage = local.restore;
        const remote = homeProfileForTests('stale-profile', 'https://remote.example.test');
        const localStack = homeProfileForTests('local-stack', 'http://localhost:3010');
        local.store.set(
            scopedStorageId('auth_credentials__srv_stale-profile', readStorageScopeFromEnv()),
            JSON.stringify({ token: 'token-stale', secret: 'secret-stale' }),
        );

        await seedPersistedHomeProfilesForTests({ profiles: [remote, localStack], activeServerId: localStack.id });
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();

        await seedPersistedHomeProfilesForTests({ profiles: [remote, localStack], activeServerId: remote.id });
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-stale', secret: 'secret-stale' });
    });

    it('reads primary credentials during Home mutation contention while writers remain exclusive', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;
        const endpoint = 'https://contended.example.test';
        const original = { token: 'original', secret: 'original-secret' };
        const replacement = { token: 'replacement', secret: 'replacement-secret' };
        await setServerUrl(endpoint);
        await expect(TokenStorage.setCredentials(original)).resolves.toBe(true);

        let release!: () => void;
        let acquired!: () => void;
        const holding = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { acquired = resolve; });
        const holder = withHomeMutationAuthority(undefined, async () => {
            acquired();
            await holding;
        });
        await started;
        const values: unknown[] = [];
        const readers = Promise.all([
            TokenStorage.getCredentials().then((value) => { values.push(value); }),
            TokenStorage.getCredentialsForServerUrl(endpoint).then((value) => { values.push(value); }),
        ]);
        let written = false;
        const writer = TokenStorage.setCredentialsForServerUrl(endpoint, {}, replacement)
            .then((result) => { written = result; });
        try {
            await vi.waitFor(() => expect(values).toEqual([original, original]));
            expect(written).toBe(false);
        } finally {
            release();
            await Promise.all([holder, readers, writer]);
        }
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint)).resolves.toEqual(replacement);
    });

    it('keeps credentials separate across web storage scopes for the same server URL', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;


        await setServerUrl('https://server-a.example.test');

        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'scope-a';
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'scope-b';
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'scope-a';
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-a', secret: 'secret-a' });

        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'scope-b';
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-b', secret: 'secret-b' });
    });

    it('rechecks the storage namespace when it changes during a primary read', async () => {
        const storage = installLocalStorageMock();
        restoreLocalStorage = storage.restore;
        await setServerUrl('https://inflight-storage-scope.example.test');
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'inflight-a';
        await TokenStorage.setCredentials({ token: 'account-a' });
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'inflight-b';
        await TokenStorage.setCredentials({ token: 'account-b' });
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'inflight-a';
        let changed = false;
        storage.getItemMock.mockImplementation((key) => {
            const value = storage.store.get(key) ?? null;
            if (!changed && value === JSON.stringify({ token: 'account-a' })) {
                changed = true;
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'inflight-b';
            }
            return value;
        });
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'account-b' });
        expect(changed).toBe(true);
    });

    it('can read and clear credentials for a specific server URL (without switching active server)', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;


        await setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        await setServerUrl('https://server-b.example.test');
        await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

        await expect(TokenStorage.getCredentialsForServerUrl('https://server-a.example.test')).resolves.toEqual({
            token: 'token-a',
            secret: 'secret-a',
        });
        await expect(TokenStorage.getCredentialsForServerUrl('https://server-b.example.test')).resolves.toEqual({
            token: 'token-b',
            secret: 'secret-b',
        });
        await expect(TokenStorage.getCredentialsForServerUrl('https://missing.example.test')).resolves.toBeNull();

        await expect(TokenStorage.removeCredentialsForServerUrl('https://server-a.example.test')).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl('https://server-a.example.test')).resolves.toBeNull();
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-b', secret: 'secret-b' });
    });

    it('refuses an old credential removal after a new writer owns the same Home, and preserves idempotent absence', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;
        const endpoint = 'https://guarded-removal.example.test';
        const original = { token: 'original', secret: 'original-secret' };
        const replacement = { token: 'replacement', secret: 'replacement-secret' };
        await expect(TokenStorage.setCredentialsForServerUrl(endpoint, {}, original)).resolves.toBe(true);
        await expect(TokenStorage.setCredentialsForServerUrl(endpoint, { expectedCredentials: original }, replacement)).resolves.toBe(true);
        await expect(TokenStorage.removeCredentialsForServerUrl(endpoint, { expectedCredentials: original })).resolves.toBe(false);
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint)).resolves.toEqual(replacement);
        await expect(TokenStorage.removeCredentialsForServerUrl(endpoint, { expectedCredentials: replacement })).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint)).resolves.toBeNull();
        await expect(TokenStorage.removeCredentialsForServerUrl(endpoint, { expectedCredentials: replacement })).resolves.toBe(true);
    });

    it('retains unreadable credential custody when a guarded removal cannot verify its expected bearer', async () => {
        const browserStorage = installLocalStorageMock();
        restoreLocalStorage = browserStorage.restore;
        const endpoint = 'https://unreadable-removal.example.test';
        const replacement = { token: 'replacement-bearer', secret: 'replacement-secret' };
        await expect(TokenStorage.setCredentialsForServerUrl(endpoint, {}, replacement)).resolves.toBe(true);
        const entry = [...browserStorage.store.entries()].find(([key, raw]) => key.includes('auth_credentials') && raw === JSON.stringify(replacement));
        if (!entry) throw new Error('Expected persisted credential custody');
        browserStorage.getItemMock.mockImplementation(key => { if (key === entry[0]) throw new Error('Browser storage read refused'); return browserStorage.store.get(key) ?? null; });
        const removal = await TokenStorage.removeCredentialsForServerUrl(endpoint, { expectedCredentials: { token: 'older-bearer', secret: 'older-secret' } }).catch(() => false);
        expect(removal).toBe(false);
        expect(browserStorage.store.get(entry[0])).toBe(entry[1]);
        browserStorage.getItemMock.mockImplementation(key => browserStorage.store.get(key) ?? null);
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint)).resolves.toEqual(replacement);
    });

    it('treats localhost and 127.0.0.1 as the same server scope for credentials', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;


        await setServerUrl('http://127.0.0.1:3010');
        await expect(TokenStorage.setCredentials({ token: 'token-loopback', secret: 'secret-loopback' })).resolves.toBe(true);

        await expect(TokenStorage.getCredentialsForServerUrl('http://localhost:3010')).resolves.toEqual({
            token: 'token-loopback',
            secret: 'secret-loopback',
        });

        await expect(TokenStorage.getCredentialsForServerUrl('http://qa-stack.localhost:3010')).resolves.toEqual({
            token: 'token-loopback',
            secret: 'secret-loopback',
        });

        await setServerUrl('http://localhost:3010');
        await expect(TokenStorage.getCredentials()).resolves.toEqual({
            token: 'token-loopback',
            secret: 'secret-loopback',
        });
    });

    it('migrates credentials from a legacy host-derived server id to the learned server identity id', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const relay = homeProfileForTests('relay.example.test', 'https://relay.example.test', { name: 'Relay' });
        await seedPersistedHomeProfilesForTests({ profiles: [relay], activeServerId: relay.id });

        await expect(TokenStorage.setCredentials({ token: 'token-legacy-id', secret: 'secret-legacy-id' })).resolves.toBe(true);

        // Feature discovery learns the stable identity for the URL this profile already holds.
        await expect(setServerProfileIdentityForUrl(relay.serverUrl, 'srv_identity_credentials')).resolves.not.toBeNull();

        await expect(TokenStorage.getCredentials()).resolves.toEqual({
            token: 'token-legacy-id',
            secret: 'secret-legacy-id',
        });

        const migrated = [...localStorageHandle.store.entries()].filter(
            ([key, value]) =>
                key.includes('auth_credentials__srv_srv_identity_credentials') &&
                value === JSON.stringify({ token: 'token-legacy-id', secret: 'secret-legacy-id' }),
        );
        expect(migrated).toHaveLength(1);
    });

    it('can read exact same-URL alternate profile credentials by serverId', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;
        const sharedUrl = 'https://shared.example.test';
        // The profile owner folds same-URL profiles unless they are distinct canonical Homes
        // (serverProfiles.ts dedupeEquivalentProfiles), so model that reachable shape.
        const profiles = [
            homeProfileForTests('server-a', sharedUrl, { name: 'Server A', serverIdentityId: 'srv_shared_a', canonicalServerUrl: sharedUrl }),
            homeProfileForTests('server-b', sharedUrl, { name: 'Server B', serverIdentityId: 'srv_shared_b', canonicalServerUrl: sharedUrl }),
        ];

        await seedPersistedHomeProfilesForTests({ profiles, activeServerId: 'server-a' });
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        await seedPersistedHomeProfilesForTests({ profiles, activeServerId: 'server-b' });
        await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

        await expect(TokenStorage.getCredentialsForServerUrl(sharedUrl, { serverId: 'server-a' })).resolves.toEqual({
            token: 'token-a',
            secret: 'secret-a',
        });
        await expect(TokenStorage.getCredentialsForServerUrl(sharedUrl, { serverId: 'server-b' })).resolves.toEqual({
            token: 'token-b',
            secret: 'secret-b',
        });

        await seedPersistedHomeProfilesForTests({ profiles, activeServerId: 'server-a' });
        await expect(TokenStorage.removeCredentialsForServerUrl(sharedUrl, { serverId: 'server-b' })).resolves.toBe(true);

        await expect(TokenStorage.getCredentialsForServerUrl(sharedUrl, { serverId: 'server-a' })).resolves.toEqual({
            token: 'token-a',
            secret: 'secret-a',
        });
        await expect(TokenStorage.getCredentialsForServerUrl(sharedUrl, { serverId: 'server-b' })).resolves.toBeNull();
    });

    it('reports exact target credential removal failure and restores earlier deleted copies', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        await seedPersistedHomeProfilesForTests({
            profiles: [
                homeProfileForTests('relay-profile', 'https://relay.example.test', {
                    name: 'Relay',
                    serverIdentityId: 'srv_identity_relay',
                    legacyServerIds: ['relay-legacy'],
                }),
                homeProfileForTests('other-server', 'https://other.example.test', { name: 'Other' }),
            ],
            activeServerId: 'other-server',
        });

        const storageScope = readStorageScopeFromEnv();
        const primaryKey = scopedStorageId('auth_credentials__srv_srv_identity_relay', storageScope);
        const legacyKey = scopedStorageId('auth_credentials__srv_relay-profile', storageScope);
        const globalKey = scopedStorageId('auth_credentials', storageScope);
        const primaryRaw = JSON.stringify({
            token: 'target-token',
            secret: 'target-secret',
        });
        const legacyRaw = JSON.stringify({
            token: 'legacy-token',
            secret: 'legacy-secret',
        });
        const unrelatedGlobalRaw = JSON.stringify({
            token: 'unrelated-token',
            secret: 'unrelated-secret',
        });
        localStorageHandle.store.set(primaryKey, primaryRaw);
        localStorageHandle.store.set(legacyKey, legacyRaw);
        localStorageHandle.store.set(globalKey, unrelatedGlobalRaw);
        localStorageHandle.removeItemMock.mockImplementation((key: string) => {
            if (key === legacyKey) {
                throw new Error('legacy delete failed');
            }
            localStorageHandle.store.delete(key);
        });

        await expect(TokenStorage.removeCredentialsForServerUrl(
            'https://relay.example.test',
            { serverId: 'relay-profile' },
        )).resolves.toBe(false);

        expect(localStorageHandle.store.get(primaryKey)).toBe(primaryRaw);
        expect(localStorageHandle.store.get(legacyKey)).toBe(legacyRaw);
        expect(localStorageHandle.store.get(globalKey)).toBe(
            unrelatedGlobalRaw,
        );
    });

    it('migrates credentials stored under legacy URL hashing when normalization changes (127.0.0.1 -> localhost)', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;


        const legacyNormalized = 'http://127.0.0.1:3010';
        const legacyHash = await digest('SHA-256', new TextEncoder().encode(legacyNormalized));
        const legacyScopeToken = encodeBase64(legacyHash, 'base64url');
        const legacyKey = scopedStorageId(`auth_credentials__srv_${legacyScopeToken}`, readStorageScopeFromEnv());

        localStorageHandle.store.set(
            legacyKey,
            JSON.stringify({ token: 'token-legacy', secret: 'secret-legacy' }),
        );

        const normalized = 'http://localhost:3010';
        await setServerUrl(normalized);


        await expect(TokenStorage.getCredentials()).resolves.toEqual({
            token: 'token-legacy',
            secret: 'secret-legacy',
        });

        const migrated = [...localStorageHandle.store.entries()].filter(
            ([key, value]) => key !== legacyKey && value === JSON.stringify({ token: 'token-legacy', secret: 'secret-legacy' }),
        );
        expect(migrated.length).toBe(1);
        expect(localStorageHandle.store.has(legacyKey)).toBe(false);
    });

    it('clears credentials across configured server scopes on explicit logout', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;
        const profiles = [
            homeProfileForTests('server-a', 'https://server-a.example.test', { name: 'Server A', serverIdentityId: 'srv_identity_a' }),
            homeProfileForTests('server-b', 'https://server-b.example.test', { name: 'Server B', serverIdentityId: 'srv_identity_b' }),
        ];
        await seedPersistedHomeProfilesForTests({ profiles, activeServerId: 'server-a' });

        await expect(TokenStorage.setCredentialsForServerUrl(
            profiles[0]!.serverUrl,
            { serverId: profiles[0]!.id },
            { token: 'token-a', secret: 'secret-a' },
        )).resolves.toBe(true);
        await expect(TokenStorage.setCredentialsForServerUrl(
            profiles[1]!.serverUrl,
            { serverId: profiles[1]!.id },
            { token: 'token-b', secret: 'secret-b' },
        )).resolves.toBe(true);

        const events: HomeCredentialMutationEvent[] = [];
        const unsubscribe = subscribeHomeCredentialMutations((event) => events.push(event));
        try {
            await expect(TokenStorage.removeCredentials()).resolves.toBe(true);

            await expect(TokenStorage.getCredentialsForServerUrl(
                profiles[0]!.serverUrl,
                { serverId: profiles[0]!.id },
            )).resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(
                profiles[1]!.serverUrl,
                { serverId: profiles[1]!.id },
            )).resolves.toBeNull();
            expect(events).toEqual([
                { kind: 'credentials_removed', serverId: 'srv_identity_a', serverUrl: profiles[0]!.serverUrl },
                { kind: 'credentials_removed', serverId: 'srv_identity_b', serverUrl: profiles[1]!.serverUrl },
            ]);
        } finally {
            unsubscribe();
        }
    });

    it('emits bulk-removal events only for Home targets whose credential removal succeeds', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const profiles = [
            homeProfileForTests('server-a', 'https://server-a.example.test', { name: 'Server A', serverIdentityId: 'srv_identity_a' }),
            homeProfileForTests('server-b', 'https://server-b.example.test', { name: 'Server B', serverIdentityId: 'srv_identity_b' }),
        ];
        await seedPersistedHomeProfilesForTests({ profiles, activeServerId: 'server-a' });

        for (const [index, profile] of profiles.entries()) {
            await expect(TokenStorage.setCredentialsForServerUrl(
                profile.serverUrl,
                { serverId: profile.id },
                { token: `token-${index}` },
            )).resolves.toBe(true);
        }
        localStorageHandle.removeItemMock.mockImplementation((key: string) => {
            if (key.includes('auth_credentials__srv_server-b')) {
                throw new Error('server B legacy removal failed');
            }
            localStorageHandle.store.delete(key);
        });

        const events: HomeCredentialMutationEvent[] = [];
        const unsubscribe = subscribeHomeCredentialMutations((event) => events.push(event));
        try {
            await expect(TokenStorage.removeCredentials()).resolves.toBe(false);

            expect(events).toEqual([
                { kind: 'credentials_removed', serverId: 'srv_identity_a', serverUrl: profiles[0]!.serverUrl },
            ]);
            await expect(TokenStorage.getCredentialsForServerUrl(
                profiles[1]!.serverUrl,
                { serverId: profiles[1]!.id },
            )).resolves.toEqual({ token: 'token-1' });
        } finally {
            unsubscribe();
        }
    });

    it('writes explicit Home credentials without changing the focused server', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;
        await setServerUrl('https://focused.example.test');
        const before = getActiveServerUrl();
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://secondary.example.test',
            {},
            { token: 'secondary' },
        )).resolves.toBe(true);
        expect(getActiveServerUrl()).toBe(before);
        await expect(TokenStorage.getCredentialsForServerUrl('https://secondary.example.test')).resolves.toEqual({ token: 'secondary' });
    });

    it('notifies exact-target Home credential mutations only after successful explicit writes and removals', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;
        let unsubscribe: (() => void) | null = null;

        await seedPersistedHomeProfilesForTests({
            profiles: [
                homeProfileForTests('server-a', 'https://focused.example.test', { name: 'Server A' }),
                homeProfileForTests('server-b', 'https://secondary.example.test', {
                    name: 'Server B',
                    serverIdentityId: 'srv_identity_b',
                }),
            ],
            activeServerId: 'server-a',
        });

        try {
            await setServerUrl('https://focused.example.test');

            const events: HomeCredentialMutationEvent[] = [];
            unsubscribe = subscribeHomeCredentialMutations((event) => {
                events.push(event);
            });

            // Focused and explicit Home writers publish through the same mutation seam.
            await expect(TokenStorage.setCredentials({ token: 'focused-token' })).resolves.toBe(true);
            expect(events).toEqual([
                { kind: 'credentials_set', serverId: 'server-a', serverUrl: 'https://focused.example.test' },
            ]);
            events.length = 0;

            // Canonical identity: the input URL normalizes to the stored scope URL and
            // the resolved identity is the profile's stable server identity.
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://secondary.example.test/',
                { serverId: 'server-b' },
                { token: 'secondary-token' },
            )).resolves.toBe(true);
            expect(events).toEqual([
                { kind: 'credentials_set', serverId: 'srv_identity_b', serverUrl: 'https://secondary.example.test' },
            ]);

            await expect(TokenStorage.removeCredentialsForServerUrl(
                'https://secondary.example.test',
                { serverId: 'srv_identity_b' },
            )).resolves.toBe(true);
            expect(events).toEqual([
                { kind: 'credentials_set', serverId: 'srv_identity_b', serverUrl: 'https://secondary.example.test' },
                { kind: 'credentials_removed', serverId: 'srv_identity_b', serverUrl: 'https://secondary.example.test' },
            ]);

            // An existing profile identity cannot be attributed to a different URL:
            // the write fails closed instead of landing under the URL hash.
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://unrelated.example.test',
                { serverId: 'server-b' },
                { token: 'unrelated-token' },
            )).resolves.toBe(false);
            expect(events).toHaveLength(2);
            await expect(TokenStorage.getCredentialsForServerUrl('https://unrelated.example.test')).resolves.toBeNull();

            // Enrollment can persist credentials under the stable Home identity
            // before profile adoption. Token invalidation uses the same mutation path.
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://pre-adoption.example.test/',
                { serverId: 'srv_identity_pre_adoption' },
                { token: 'pre-adoption-token' },
            )).resolves.toBe(true);
            await expect(TokenStorage.invalidateCredentialsTokenForServerUrl(
                'https://pre-adoption.example.test',
                'different-token',
                { serverId: 'srv_identity_pre_adoption' },
            )).resolves.toBe(false);
            expect(events.at(-1)).toEqual({
                kind: 'credentials_set',
                serverId: 'srv_identity_pre_adoption',
                serverUrl: 'https://pre-adoption.example.test',
            });
            await expect(TokenStorage.invalidateCredentialsTokenForServerUrl(
                'https://pre-adoption.example.test',
                'pre-adoption-token',
                { serverId: 'srv_identity_pre_adoption' },
            )).resolves.toBe(true);
            expect(events.slice(-2)).toEqual([
                {
                    kind: 'credentials_set',
                    serverId: 'srv_identity_pre_adoption',
                    serverUrl: 'https://pre-adoption.example.test',
                },
                {
                    kind: 'credentials_removed',
                    serverId: 'srv_identity_pre_adoption',
                    serverUrl: 'https://pre-adoption.example.test',
                },
            ]);

        } finally {
            unsubscribe?.();
        }
    });

    it('emits no Home credential mutation notification when an exact-target write or removal fails', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        const events: HomeCredentialMutationEvent[] = [];
        const unsubscribe = subscribeHomeCredentialMutations((event) => {
            events.push(event);
        });
        const target = { serverId: 'srv_identity_secondary' } as const;

        try {
            // Genuine storage failure: credential writes cannot be persisted.
            localStorageHandle.setItemMock.mockImplementation((key: string, value: string) => {
                if (key.includes('auth_credentials__srv_')) {
                    throw new Error('storage write failed');
                }
                localStorageHandle.store.set(key, value);
            });

            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://secondary.example.test',
                target,
                { token: 'secondary-token' },
            )).resolves.toBe(false);
            expect(events).toEqual([]);

            localStorageHandle.setItemMock.mockImplementation((key: string, value: string) => {
                localStorageHandle.store.set(key, value);
            });
            await expect(TokenStorage.setCredentialsForServerUrl(
                'https://secondary.example.test',
                target,
                { token: 'secondary-token' },
            )).resolves.toBe(true);
            expect(events).toHaveLength(1);

            localStorageHandle.removeItemMock.mockImplementation((key: string) => {
                if (key.includes('auth_credentials__srv_')) {
                    throw new Error('storage remove failed');
                }
                localStorageHandle.store.delete(key);
            });

            await expect(TokenStorage.removeCredentialsForServerUrl(
                'https://secondary.example.test',
                target,
            )).resolves.toBe(false);
            expect(events).toHaveLength(1);
        } finally {
            unsubscribe();
            vi.restoreAllMocks();
        }
    });

    it('keeps a pre-adoption credential unreadable when a competing identity claims the URL', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const focused = homeProfileForTests('focused', 'https://focused.example.test');
        await seedPersistedHomeProfilesForTests({ profiles: [focused], activeServerId: focused.id });

        await setServerUrl('https://focused.example.test');

        // Home A preflights identity A at the shared URL and persists its
        // credential before any profile exists.
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://shared.example.test',
            { serverId: 'srv_home_a' },
            { token: 'home-a-token' },
        )).resolves.toBe(true);

        // The competing adoption claims the same URL under identity B
        // (profile committed, credential step still pending).
        await seedPersistedHomeProfilesForTests({
            profiles: [focused, homeProfileForTests('server-b', 'https://shared.example.test', { name: 'Home B', serverIdentityId: 'srv_home_b' })],
            activeServerId: focused.id,
        });

        // A's final adoption fails closed. Neither B's reader nor a URL-only
        // lookup may migrate or read A's credential.
        await expect(TokenStorage.getCredentialsForServerUrl('https://shared.example.test')).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://shared.example.test',
            { serverId: 'srv_home_b' },
        )).resolves.toBeNull();

        // Once B owns the URL, even A's explicit identity reader fails
        // closed until the losing write is rolled back.
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://shared.example.test',
            { serverId: 'srv_home_a' },
        )).resolves.toBeNull();
    });

    it('rejects a pre-profile identity write when another Home already owns the URL', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        await seedPersistedHomeProfilesForTests({
            profiles: [homeProfileForTests('focused', 'https://focused.example.test'), homeProfileForTests('server-b', 'https://shared.example.test', { name: 'Home B', serverIdentityId: 'srv_home_b' })],
            activeServerId: 'focused',
        });

        await setServerUrl('https://focused.example.test');

        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://shared.example.test',
            { serverId: 'srv_home_a' },
            { token: 'home-a-token' },
        )).resolves.toBe(false);
        await expect(TokenStorage.setCredentialsForServerUrlWithRollback(
            'https://shared.example.test',
            { serverId: 'srv_home_a' },
            { token: 'home-a-token' },
        )).resolves.toBeNull();
        for (const [, value] of localStorageHandle.store) {
            expect(value).not.toContain('home-a-token');
        }
    });

    it('rolls back exactly the failed pre-adoption write and never the concurrent winner credentials', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        const focused = homeProfileForTests('focused', 'https://focused.example.test');
        await seedPersistedHomeProfilesForTests({ profiles: [focused], activeServerId: focused.id });
        let claim: Promise<void> | null = null;
        localStorageHandle.setItemMock.mockImplementation((key: string, value: string) => {
            localStorageHandle.store.set(key, value);
            if (!value.includes('home-a-token') || claim) return;
            // Deterministically claim the URL after A resolved its identity but
            // before A's async credential write returns to the composition owner.
            // The profile owner reads the persisted bytes synchronously, so the claim is visible at once.
            claim = seedPersistedHomeProfilesForTests({
                profiles: [focused, homeProfileForTests('server-b', 'https://shared.example.test', { name: 'Home B', serverIdentityId: 'srv_home_b' })],
                activeServerId: focused.id,
            });
        });

        await setServerUrl('https://focused.example.test');

        const receipt = await TokenStorage.setCredentialsForServerUrlWithRollback(
            'https://shared.example.test',
            { serverId: 'srv_home_a' },
            { token: 'home-a-token' },
        );
        expect(receipt).toMatchObject({ serverUrl: 'https://shared.example.test', serverId: 'srv_home_a' });
        await claim;

        // B completes its own write after claiming the URL while A's write
        // was in flight.
        await expect(TokenStorage.setCredentialsForServerUrl(
            'https://shared.example.test',
            { serverId: 'srv_home_b' },
            { token: 'home-b-token' },
        )).resolves.toBe(true);

        // A's final adoption fails; the attempted write is undone exactly.
        await expect(receipt!.rollback()).resolves.toBe(true);

        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://shared.example.test',
            { serverId: 'srv_home_b' },
        )).resolves.toEqual({ token: 'home-b-token' });
        await expect(TokenStorage.getCredentialsForServerUrl('https://shared.example.test')).resolves.toEqual({ token: 'home-b-token' });
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://shared.example.test',
            { serverId: 'srv_home_a' },
        )).resolves.toBeNull();
        for (const [, value] of localStorageHandle.store) {
            expect(value).not.toContain('home-a-token');
        }
    });

    it('never resurrects reader-only aliases emptied by a newer URL-scope writer', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        // Seed both URL-hash aliases with an older pre-identity credential. The
        // identity-scoped write will clear both as reader-only migration inputs.
        const endpoint = 'http://localhost:3010';
        const canonicalHash = await digest('SHA-256', new TextEncoder().encode(endpoint));
        const legacyHash = await digest('SHA-256', new TextEncoder().encode('http://127.0.0.1:3010'));
        const storageScope = readStorageScopeFromEnv();
        const canonicalKey = scopedStorageId(`auth_credentials__srv_${encodeBase64(canonicalHash, 'base64url')}`, storageScope);
        const legacyKey = scopedStorageId(`auth_credentials__srv_${encodeBase64(legacyHash, 'base64url')}`, storageScope);
        const olderRaw = JSON.stringify({ token: 'older-url-token' });
        localStorageHandle.store.set(canonicalKey, olderRaw);
        localStorageHandle.store.set(legacyKey, olderRaw);

        const focused = homeProfileForTests('focused', 'https://focused.example.test');
        await seedPersistedHomeProfilesForTests({
            profiles: [focused, homeProfileForTests('server-a', endpoint, { name: 'Home A', serverIdentityId: 'srv_home_a' })],
            activeServerId: focused.id,
        });

        await setServerUrl('https://focused.example.test');

        const receipt = await TokenStorage.setCredentialsForServerUrlWithRollback(
            endpoint,
            { serverId: 'srv_home_a' },
            { token: 'home-a-token' },
        );
        expect(receipt).not.toBeNull();

        // The profile disappears when adoption loses. A newer manual writer
        // now owns the canonical URL slot and intentionally empties the
        // alternate loopback alias.
        await seedPersistedHomeProfilesForTests({ profiles: [focused], activeServerId: focused.id });
        await expect(TokenStorage.setCredentialsForServerUrl(
            endpoint,
            {},
            { token: 'manual-url-token' },
        )).resolves.toBe(true);

        await expect(receipt!.rollback()).resolves.toBe(true);

        // The attempted identity write is gone, but no older URL bytes were
        // resurrected into any alias that the newer writer had emptied.
        await expect(TokenStorage.getCredentialsForServerUrl(
            endpoint,
            { serverId: 'srv_home_a' },
        )).resolves.toBeNull();
        for (const [, value] of localStorageHandle.store) {
            expect(value).not.toContain('home-a-token');
            expect(value).not.toContain('older-url-token');
        }
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint)).resolves.toEqual({ token: 'manual-url-token' });

        // Removing the newer token must not uncover and migrate the older
        // credential from an alternate alias on a later read.
        await expect(TokenStorage.invalidateCredentialsTokenForServerUrl(
            endpoint,
            'manual-url-token',
        )).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint)).resolves.toBeNull();
        expect(localStorageHandle.store.get(canonicalKey)).toBeUndefined();
        expect(localStorageHandle.store.get(legacyKey)).toBeUndefined();
    });

    it('never restores seeded aliases after a newer same-identity writer owns primary', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        const endpoint = 'http://localhost:3010';
        const canonicalHash = await digest('SHA-256', new TextEncoder().encode(endpoint));
        const legacyHash = await digest('SHA-256', new TextEncoder().encode('http://127.0.0.1:3010'));
        const storageScope = readStorageScopeFromEnv();
        const canonicalKey = scopedStorageId(`auth_credentials__srv_${encodeBase64(canonicalHash, 'base64url')}`, storageScope);
        const legacyKey = scopedStorageId(`auth_credentials__srv_${encodeBase64(legacyHash, 'base64url')}`, storageScope);
        const olderRaw = JSON.stringify({ token: 'older-url-token' });
        localStorageHandle.store.set(canonicalKey, olderRaw);
        localStorageHandle.store.set(legacyKey, olderRaw);

        await seedPersistedHomeProfilesForTests({
            profiles: [homeProfileForTests('focused', 'https://focused.example.test'), homeProfileForTests('server-a', endpoint, { name: 'Home A', serverIdentityId: 'srv_home_a' })],
            activeServerId: 'focused',
        });

        const target = { serverId: 'srv_home_a' } as const;
        const receipt = await TokenStorage.setCredentialsForServerUrlWithRollback(
            endpoint,
            target,
            { token: 'rollback-candidate' },
        );
        expect(receipt).not.toBeNull();

        await expect(TokenStorage.setCredentialsForServerUrl(
            endpoint,
            target,
            { token: 'newer-same-identity-token' },
        )).resolves.toBe(true);
        await expect(receipt!.rollback()).resolves.toBe(false);

        await expect(TokenStorage.getCredentialsForServerUrl(endpoint, target))
            .resolves.toEqual({ token: 'newer-same-identity-token' });
        expect(localStorageHandle.store.get(canonicalKey)).toBeUndefined();
        expect(localStorageHandle.store.get(legacyKey)).toBeUndefined();

        await expect(TokenStorage.invalidateCredentialsTokenForServerUrl(
            endpoint,
            'newer-same-identity-token',
            target,
        )).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint, target)).resolves.toBeNull();
    });

    it('does not sweep a browser orphan whose exact bytes changed after enumeration', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const orphanKey = scopedStorageId('auth_credentials__srv_orphaned-browser-scope', readStorageScopeFromEnv());
        const olderRaw = JSON.stringify({ token: 'orphaned-token' });
        const newerRaw = JSON.stringify({ token: 'newer-orphaned-token' });
        localStorageHandle.store.set(orphanKey, olderRaw);

        let replaceAfterEnumeration = true;
        vi.mocked(globalThis.localStorage.key).mockImplementation((index: number) => {
            const key = [...localStorageHandle.store.keys()][index] ?? null;
            if (replaceAfterEnumeration && key === orphanKey) {
                replaceAfterEnumeration = false;
                queueMicrotask(() => localStorageHandle.store.set(orphanKey, newerRaw));
            }
            return key;
        });

        await expect(TokenStorage.removeCredentials()).resolves.toBe(true);
        expect(localStorageHandle.store.get(orphanKey)).toBe(newerRaw);
    });

    it('serializes deferred rollback with a newer same-scope credential commit', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const target = { serverId: 'srv_rollback_serialized' } as const;
        const endpoint = 'https://rollback-serialized.example.test';
        const receipt = await TokenStorage.setCredentialsForServerUrlWithRollback(
            endpoint,
            target,
            { token: 'rollback-candidate' },
        );
        expect(receipt).not.toBeNull();

        let replacement: Promise<boolean> | null = null;
        let injectReplacement = true;
        localStorageHandle.getItemMock.mockImplementation((key: string) => {
            const raw = localStorageHandle.store.get(key) ?? null;
            if (injectReplacement && raw?.includes('rollback-candidate')) {
                injectReplacement = false;
                queueMicrotask(() => {
                    replacement = TokenStorage.setCredentialsForServerUrl(
                        endpoint,
                        target,
                        { token: 'newer-credential' },
                    );
                });
            }
            return raw;
        });

        await expect(receipt!.rollback()).resolves.toBe(true);
        await vi.waitFor(() => expect(replacement).not.toBeNull());
        await expect(replacement!).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint, target))
            .resolves.toEqual({ token: 'newer-credential' });
    });

    it.each([
        ['logout', (storage: typeof import('./tokenStorage').TokenStorage, endpoint: string, target: { serverId: string }) =>
            storage.removeCredentialsForServerUrl(endpoint, target)],
        ['401 invalidation', (storage: typeof import('./tokenStorage').TokenStorage, endpoint: string, target: { serverId: string }) =>
            storage.invalidateCredentialsTokenForServerUrl(endpoint, 'credential-being-invalidated', target)],
    ])('serializes %s deletion with a newer same-scope credential commit', async (_label, remove) => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const target = { serverId: 'srv_remove_serialized' } as const;
        const endpoint = 'https://remove-serialized.example.test';
        await expect(TokenStorage.setCredentialsForServerUrl(
            endpoint,
            target,
            { token: 'credential-being-invalidated' },
        )).resolves.toBe(true);

        let replacement: Promise<boolean> | null = null;
        let injectReplacement = true;
        localStorageHandle.getItemMock.mockImplementation((key: string) => {
            const raw = localStorageHandle.store.get(key) ?? null;
            if (injectReplacement && raw?.includes('credential-being-invalidated')) {
                injectReplacement = false;
                queueMicrotask(() => {
                    replacement = TokenStorage.setCredentialsForServerUrl(
                        endpoint,
                        target,
                        { token: 'newer-credential' },
                    );
                });
            }
            return raw;
        });

        await expect(remove(TokenStorage, endpoint, target)).resolves.toBe(true);
        await vi.waitFor(() => expect(replacement).not.toBeNull());
        await expect(replacement!).resolves.toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(endpoint, target))
            .resolves.toEqual({ token: 'newer-credential' });
    });
});
