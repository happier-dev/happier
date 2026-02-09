import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installLocalStorageMock, type LocalStorageMockHandle } from './tokenStorage.web.testHelpers';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

describe('TokenStorage pending external auth (web)', () => {
    let restoreLocalStorage: (() => void) | null = null;
    let localStorageHandle: LocalStorageMockHandle | null = null;

    beforeEach(() => {
        vi.resetModules();
        localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        localStorageHandle = null;
    });

    it('round-trips pending external auth state', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        expect(typeof TokenStorage.setPendingExternalAuth).toBe('function');
        expect(typeof TokenStorage.getPendingExternalAuth).toBe('function');
        expect(typeof TokenStorage.clearPendingExternalAuth).toBe('function');

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();

        const ok = await TokenStorage.setPendingExternalAuth({ provider: 'github', secret: 's' });
        expect(ok).toBe(true);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({ provider: 'github', secret: 's' });

        const cleared = await TokenStorage.clearPendingExternalAuth();
        expect(cleared).toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    it('returns null for malformed pending external auth payloads', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        localStorageHandle.getItemMock.mockReturnValueOnce(JSON.stringify({ provider: 123, secret: true }));

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });
});
