import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';
import { installLocalStorageMock } from './tokenStorage.web.testHelpers';

installTokenStorageWebPlatformMocks();

describe('TokenStorage (web) server-scoped credentials', () => {
    let restoreLocalStorage: (() => void) | null = null;
    const previousStorageScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        if (previousStorageScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousStorageScope;
        try {
            const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
            setServerUrl(null);
        } catch {
            // ignore
        }
    });

    it('keeps credentials separate per server URL', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { TokenStorage } = await import('./tokenStorage');

        setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        setServerUrl('https://server-b.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

        setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-a', secret: 'secret-a' });

        setServerUrl('https://server-b.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-b', secret: 'secret-b' });
    });

    it('keeps credentials separate across web storage scopes for the same server URL', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { TokenStorage } = await import('./tokenStorage');

        setServerUrl('https://server-a.example.test');

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

    it('can read and clear credentials for a specific server URL (without switching active server)', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { TokenStorage } = await import('./tokenStorage');

        setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        setServerUrl('https://server-b.example.test');
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

    it('treats localhost and 127.0.0.1 as the same server scope for credentials', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { TokenStorage } = await import('./tokenStorage');

        setServerUrl('http://127.0.0.1:3010');
        await expect(TokenStorage.setCredentials({ token: 'token-loopback', secret: 'secret-loopback' })).resolves.toBe(true);

        await expect(TokenStorage.getCredentialsForServerUrl('http://localhost:3010')).resolves.toEqual({
            token: 'token-loopback',
            secret: 'secret-loopback',
        });

        await expect(TokenStorage.getCredentialsForServerUrl('http://qa-stack.localhost:3010')).resolves.toEqual({
            token: 'token-loopback',
            secret: 'secret-loopback',
        });

        setServerUrl('http://localhost:3010');
        await expect(TokenStorage.getCredentials()).resolves.toEqual({
            token: 'token-loopback',
            secret: 'secret-loopback',
        });
    });

    it('migrates credentials from a legacy host-derived server id to the learned server identity id', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        const state = {
            serverIdentityId: null as string | null,
        };

        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.serverIdentityId ?? 'relay.example.test',
                getActiveServerUrl: () => 'https://relay.example.test',
                listServerProfiles: () => [{
                    id: 'relay.example.test',
                    serverUrl: 'https://relay.example.test',
                    name: 'Relay',
                    ...(state.serverIdentityId
                        ? {
                            serverIdentityId: state.serverIdentityId,
                            legacyServerIds: ['relay.example.test'],
                        }
                        : {}),
                }],
            };
        });

        try {
            const { TokenStorage } = await import('./tokenStorage');
            await expect(TokenStorage.setCredentials({ token: 'token-legacy-id', secret: 'secret-legacy-id' })).resolves.toBe(true);

            state.serverIdentityId = 'srv_identity_credentials';

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
        } finally {
            vi.doUnmock('@/sync/domains/server/serverProfiles');
        }
    });

    it('can read exact same-URL alternate profile credentials by serverId', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        const state = {
            activeServerId: 'server-a',
            activeServerUrl: 'https://shared.example.test',
            profiles: [
                { id: 'server-a', serverUrl: 'https://shared.example.test', name: 'Server A' },
                { id: 'server-b', serverUrl: 'https://shared.example.test', name: 'Server B' },
            ],
        };

        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
            };
        });

        try {
            const { TokenStorage } = await import('./tokenStorage');
            const exactLookup = TokenStorage as unknown as {
                getCredentialsForServerUrl: (
                    serverUrl: string,
                    options?: Readonly<{ serverId?: string | null }>,
                ) => Promise<{ token: string; secret: string } | null>;
                removeCredentialsForServerUrl: (
                    serverUrl: string,
                    options?: Readonly<{ serverId?: string | null }>,
                ) => Promise<boolean>;
            };

            await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

            state.activeServerId = 'server-b';
            await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

            await expect(exactLookup.getCredentialsForServerUrl(state.activeServerUrl, { serverId: 'server-a' })).resolves.toEqual({
                token: 'token-a',
                secret: 'secret-a',
            });
            await expect(exactLookup.getCredentialsForServerUrl(state.activeServerUrl, { serverId: 'server-b' })).resolves.toEqual({
                token: 'token-b',
                secret: 'secret-b',
            });

            state.activeServerId = 'server-a';
            await expect(exactLookup.removeCredentialsForServerUrl(state.activeServerUrl, { serverId: 'server-b' })).resolves.toBe(true);

            await expect(exactLookup.getCredentialsForServerUrl(state.activeServerUrl, { serverId: 'server-a' })).resolves.toEqual({
                token: 'token-a',
                secret: 'secret-a',
            });
            await expect(exactLookup.getCredentialsForServerUrl(state.activeServerUrl, { serverId: 'server-b' })).resolves.toBeNull();
        } finally {
            vi.doUnmock('@/sync/domains/server/serverProfiles');
        }
    });

    it('reports exact target credential removal failure and restores earlier deleted copies', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        const state = {
            activeServerId: 'other-server',
            activeServerUrl: 'https://other.example.test',
            profiles: [
                {
                    id: 'relay-profile',
                    serverIdentityId: 'srv_identity_relay',
                    legacyServerIds: ['relay-legacy'],
                    serverUrl: 'https://relay.example.test',
                    name: 'Relay',
                },
                {
                    id: 'other-server',
                    serverUrl: 'https://other.example.test',
                    name: 'Other',
                },
            ],
        };

        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
            };
        });

        const primaryKey = 'auth_credentials__srv_srv_identity_relay';
        const legacyKey = 'auth_credentials__srv_relay-profile';
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
        localStorageHandle.store.set('auth_credentials', unrelatedGlobalRaw);
        localStorageHandle.removeItemMock.mockImplementation((key: string) => {
            if (key === legacyKey) {
                throw new Error('legacy delete failed');
            }
            localStorageHandle.store.delete(key);
        });

        try {
            const { TokenStorage } = await import('./tokenStorage');

            await expect(TokenStorage.removeCredentialsForServerUrl(
                'https://relay.example.test',
                { serverId: 'relay-profile' },
            )).resolves.toBe(false);

            expect(localStorageHandle.store.get(primaryKey)).toBe(primaryRaw);
            expect(localStorageHandle.store.get(legacyKey)).toBe(legacyRaw);
            expect(localStorageHandle.store.get('auth_credentials')).toBe(
                unrelatedGlobalRaw,
            );
        } finally {
            vi.doUnmock('@/sync/domains/server/serverProfiles');
        }
    });

    it('migrates credentials stored under legacy URL hashing when normalization changes (127.0.0.1 -> localhost)', async () => {
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;

        const { digest } = await import('@/platform/digest');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { scopedStorageId } = await import('@/utils/system/storageScope');

        const legacyNormalized = 'http://127.0.0.1:3010';
        const legacyHash = await digest('SHA-256', new TextEncoder().encode(legacyNormalized));
        const legacyScopeToken = encodeBase64(legacyHash, 'base64url');
        const legacyKey = scopedStorageId(`auth_credentials__srv_${legacyScopeToken}`, null);

        localStorageHandle.store.set(
            legacyKey,
            JSON.stringify({ token: 'token-legacy', secret: 'secret-legacy' }),
        );

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        const normalized = 'http://localhost:3010';
        setServerUrl(normalized);

        const { TokenStorage } = await import('./tokenStorage');

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

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { TokenStorage } = await import('./tokenStorage');

        setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        setServerUrl('https://server-b.example.test');
        await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

        setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.removeCredentials()).resolves.toBe(true);

        setServerUrl('https://server-a.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();

        setServerUrl('https://server-b.example.test');
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
    });
});
