import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installLocalStorageMock, type LocalStorageMockHandle } from './tokenStorage.web.testHelpers';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();

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
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerUrl: () => 'https://relay.example.test',
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        expect(typeof TokenStorage.setPendingExternalAuth).toBe('function');
        expect(typeof TokenStorage.getPendingExternalAuth).toBe('function');
        expect(typeof TokenStorage.clearPendingExternalAuth).toBe('function');

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay.example.test',
        });
        expect(ok).toBe(true);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay.example.test',
        });

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        const pendingKeys = [...localStorageHandle.store.keys()].filter((k) => k.includes('pending_external_auth'));
        expect(pendingKeys.length).toBe(2);
        expect(pendingKeys.some((k) => k.includes('__srv_'))).toBe(true);
        expect(pendingKeys.some((k) => k.includes('__global'))).toBe(true);

        // If the server-scoped key can't be resolved on return (server selection changed / lost),
        // TokenStorage should still recover the pending state from the global fallback.
        for (const key of pendingKeys) {
            if (key.includes('__srv_')) {
                localStorageHandle.store.delete(key);
            }
        }
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay.example.test',
        });

        const cleared = await TokenStorage.clearPendingExternalAuth();
        expect(cleared).toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects global fallback pending external auth when the active server changed', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerUrl: () => 'https://relay-b.example.test',
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay-a.example.test',
        });
        expect(ok).toBe(true);

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        for (const key of [...localStorageHandle.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                localStorageHandle.store.delete(key);
            }
        }

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects global fallback pending external auth when the active same-origin server profile changed', async () => {
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

        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: state.activeServerUrl,
        });
        expect(ok).toBe(true);

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        for (const key of [...localStorageHandle.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                localStorageHandle.store.delete(key);
            }
        }

        state.activeServerId = 'server-b';

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('round-trips pending external auth state with both proof and secret', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'p', secret: 's', intent: 'reset' });
        expect(ok).toBe(true);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({ provider: 'github', proof: 'p', secret: 's', intent: 'reset' });
    });

    it('round-trips pending external auth returnTo when it is an internal path', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'p', returnTo: '/settings/account' });
        expect(ok).toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({
            provider: 'github',
            proof: 'p',
            returnTo: '/settings/account',
        });
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
