import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from './tokenStorage.web.testHelpers';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

describe('TokenStorage (web) server-scoped credentials', () => {
    let restoreLocalStorage: (() => void) | null = null;

    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
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

        setServerUrl('http://localhost:3010');
        await expect(TokenStorage.getCredentials()).resolves.toEqual({
            token: 'token-loopback',
            secret: 'secret-loopback',
        });
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
