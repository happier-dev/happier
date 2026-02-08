import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installLocalStorageMock, type LocalStorageMockHandle } from './tokenStorage.web.testHelpers';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

describe('TokenStorage (web)', () => {
    let restoreLocalStorage: (() => void) | null = null;
    let localStorageHandle: LocalStorageMockHandle | null = null;

    function installStorage() {
        localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        return localStorageHandle;
    }

    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        localStorageHandle = null;
    });

    it('returns null when localStorage JSON is invalid', async () => {
        const storage = installStorage();
        storage.setItemMock('auth_credentials', '{not valid json');

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
    });

    it('returns false when localStorage.setItem throws', async () => {
        const storage = installStorage();
        storage.setItemMock.mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.setCredentials({ token: 't', secret: 's' })).resolves.toBe(false);
    });

    it('returns false when localStorage.removeItem throws', async () => {
        const storage = installStorage();
        storage.removeItemMock.mockImplementation(() => {
            throw new Error('SecurityError');
        });

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.removeCredentials()).resolves.toBe(false);
    });

    it('calls localStorage.getItem at most once per getCredentials call', async () => {
        const storage = installStorage();
        storage.setItemMock('auth_credentials', JSON.stringify({ token: 't', secret: 's' }));

        const { TokenStorage } = await import('./tokenStorage');
        await TokenStorage.getCredentials();
        expect(storage.getItemMock).toHaveBeenCalledTimes(1);
    });
});
