import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from './tokenStorage.web.testHelpers';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

describe('TokenStorage (web) server scope mismatch', () => {
    let restoreLocalStorage: (() => void) | null = null;

    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
    });

    it('does not read id-scoped credentials when active server URL differs from active server id profile', async () => {
        restoreLocalStorage = installLocalStorageMock().restore;

        // Seed credentials under a stale profile id scope.
        localStorage.setItem(
            'auth_credentials__srv_stale_profile',
            JSON.stringify({ token: 'token-stale', secret: 'secret-stale' }),
        );

        // Simulate stack-context bootstrap:
        // - active server URL is a local stack URL (env fallback)
        // - active server id still points at a different persisted profile
        // TokenStorage should treat this as "unknown server id for this URL" and avoid using the id scope.
        vi.doMock('@/sync/domains/server/serverProfiles', () => ({
            getActiveServerId: () => 'stale-profile',
            getActiveServerUrl: () => 'http://localhost:3010',
            listServerProfiles: () => [{ id: 'stale-profile', serverUrl: 'https://remote.example.test' }],
        }));

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
    });
});
