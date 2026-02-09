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
});
