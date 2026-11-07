import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from './tokenStorage.web.testHelpers';

installTokenStorageWebPlatformMocks();

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 } as const;
const SERVER_URL = 'https://relay.example.test';

async function buildRecord(password: string) {
    const { createAppLockKeys } = await import('@/auth/appLock/appLockCrypto');
    const keys = await createAppLockKeys(password, FAST_KDF);
    return {
        dataKey: keys.dataKey,
        record: {
            v: 1 as const,
            lockId: 'lock_0123456789abcdefghijkl',
            email: 'owner@example.com',
            serverUrl: SERVER_URL,
            wrapped: keys.wrapped,
            autoLockMinutes: 5,
            biometric: false,
        },
    };
}

function storedCredentialValues(handle: LocalStorageMockHandle): string[] {
    return [...handle.store.entries()]
        .filter(([key]) => key.startsWith('auth_credentials'))
        .map(([, value]) => value);
}

describe('TokenStorage (web) with the app lock', () => {
    let storage: LocalStorageMockHandle | null = null;

    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        storage?.restore();
        storage = null;
    });

    it('seals stored credentials while the lock is on and needs the password after a restart', async () => {
        storage = installLocalStorageMock();
        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl(SERVER_URL);
        const { TokenStorage } = await import('./tokenStorage');
        const { enableAppLockLocally } = await import('@/auth/appLock/appLockSetup');
        const { loadAppLock } = await import('@/auth/appLock/appLockRuntime');
        await loadAppLock();

        await TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' });
        const { record, dataKey } = await buildRecord('open sesame');
        await enableAppLockLocally(record, dataKey);

        // Existing credentials were re-sealed, and the app keeps working while unlocked.
        expect(storedCredentialValues(storage).every((value) => !value.includes('token-a'))).toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-a', secret: 'secret-a' });

        // Simulate an app restart: no data key in memory until the password is entered.
        vi.resetModules();
        const restarted = await import('./tokenStorage');
        const restartedLock = await import('@/auth/appLock/appLockRuntime');
        (await import('@/sync/domains/server/serverConfig')).setServerUrl(SERVER_URL);
        await restartedLock.loadAppLock();
        expect(restartedLock.getAppLockSnapshot().status).toBe('locked');
        await expect(restarted.TokenStorage.getCredentials()).resolves.toBeNull();
        await expect(restarted.TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(false);

        await expect(restartedLock.unlockAppLockWithPassword('wrong')).resolves.toBe(false);
        await expect(restartedLock.unlockAppLockWithPassword('open sesame')).resolves.toBe(true);
        await expect(restarted.TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-a', secret: 'secret-a' });
    });

    it('stores credentials in plain form again after the lock is turned off', async () => {
        storage = installLocalStorageMock();
        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl(SERVER_URL);
        const { TokenStorage } = await import('./tokenStorage');
        const { enableAppLockLocally, disableAppLockLocally } = await import('@/auth/appLock/appLockSetup');
        const { loadAppLock } = await import('@/auth/appLock/appLockRuntime');
        await loadAppLock();

        const { record, dataKey } = await buildRecord('pw');
        await enableAppLockLocally(record, dataKey);
        await TokenStorage.setCredentials({ token: 'token-c', secret: 'secret-c' });
        expect(storedCredentialValues(storage).some((value) => value.includes('token-c'))).toBe(false);

        await disableAppLockLocally();
        expect(storedCredentialValues(storage).some((value) => value.includes('token-c'))).toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toEqual({ token: 'token-c', secret: 'secret-c' });
    });
});
