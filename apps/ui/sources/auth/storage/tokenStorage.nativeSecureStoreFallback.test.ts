import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';

const secureStoreState = vi.hoisted(() => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

const asyncStorageState = vi.hoisted(() => {
    const values = new Map<string, string>();
    return {
        values,
        getItem: vi.fn(async (key: string) => values.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => {
            values.set(key, value);
        }),
        removeItem: vi.fn(async (key: string) => {
            values.delete(key);
        }),
    };
});

const serverProfilesState = vi.hoisted(() => ({
    activeServerId: 'server-a',
    activeServerUrl: 'https://server-a.example.test',
    profiles: [{ id: 'server-a', serverUrl: 'https://server-a.example.test' }],
}));

type DevGlobal = typeof globalThis & {
    __DEV__?: boolean;
};

const EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK = 'EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK';

function createIosSecureStoreEntitlementError(): Error {
    return new Error("Calling the 'setValueWithKeyAsync' function has failed\n→ Caused by: A required entitlement isn't present.");
}

function installServerProfilesMock(): void {
    vi.doMock('@/sync/domains/server/serverProfiles', () => ({
        getActiveServerId: () => serverProfilesState.activeServerId,
        getActiveServerUrl: () => serverProfilesState.activeServerUrl,
        listServerProfiles: () => serverProfilesState.profiles,
    }));
}

installTokenStorageWebPlatformMocks({
    reactNative: async () => {
        const stub = await import('../../dev/reactNativeStub');
        const platform = {
            ...(stub.Platform ?? {}),
            OS: 'ios',
            select: (options: Record<string, unknown>) =>
                options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
        };
        return {
            ...stub,
            Platform: platform,
            AppState: {
                ...(stub.AppState ?? {}),
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
        };
    },
    secureStore: async () => secureStoreState,
    asyncStorage: async () => ({
        default: asyncStorageState,
    }),
});

describe('TokenStorage (native secure-store entitlement fallback)', () => {
    let originalDev: boolean | undefined;
    let originalFallbackEnv: string | undefined;
    const devGlobal = globalThis as DevGlobal;

    beforeEach(() => {
        vi.resetModules();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        secureStoreState.getItemAsync.mockReset();
        secureStoreState.setItemAsync.mockReset();
        secureStoreState.deleteItemAsync.mockReset();
        asyncStorageState.getItem.mockClear();
        asyncStorageState.setItem.mockClear();
        asyncStorageState.removeItem.mockClear();
        asyncStorageState.values.clear();
        secureStoreState.getItemAsync.mockRejectedValue(createIosSecureStoreEntitlementError());
        secureStoreState.setItemAsync.mockRejectedValue(createIosSecureStoreEntitlementError());
        secureStoreState.deleteItemAsync.mockRejectedValue(createIosSecureStoreEntitlementError());
        installServerProfilesMock();
        originalDev = devGlobal.__DEV__;
        originalFallbackEnv = process.env[EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK];
        delete process.env[EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK];
        devGlobal.__DEV__ = true;
    });

    afterEach(() => {
        vi.doUnmock('@/sync/domains/server/serverProfiles');
        vi.doUnmock('react-native-mmkv');
        vi.restoreAllMocks();
        asyncStorageState.values.clear();
        if (originalDev === undefined) {
            delete devGlobal.__DEV__;
        } else {
            devGlobal.__DEV__ = originalDev;
        }
        if (originalFallbackEnv === undefined) {
            delete process.env[EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK];
        } else {
            process.env[EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK] = originalFallbackEnv;
        }
    });

    it('reads credentials back after reload when secure store entitlements are unavailable in dev', async () => {
        const credentials = { token: 'token-dev', secret: 'secret-dev' } as const;

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.setCredentials(credentials)).resolves.toBe(true);

        vi.resetModules();
        installServerProfilesMock();

        const reloaded = await import('./tokenStorage');
        await expect(reloaded.TokenStorage.getCredentials()).resolves.toEqual(credentials);
    });

    it('roundtrips auth auto redirect suppression when secure store entitlements are unavailable in dev', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        await expect(TokenStorage.setAuthAutoRedirectSuppressedUntil(123456)).resolves.toBe(true);

        vi.resetModules();
        installServerProfilesMock();

        const reloaded = await import('./tokenStorage');
        await expect(reloaded.TokenStorage.getAuthAutoRedirectSuppressedUntil()).resolves.toBe(123456);
    });

    it('does not fall back to MMKV outside dev mode', async () => {
        process.env[EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK] = '0';
        devGlobal.__DEV__ = false;

        const { Platform } = await import('react-native');
        expect(Platform.OS).toBe('ios');

        const { TokenStorage } = await import('./tokenStorage');
        await expect(TokenStorage.setCredentials({ token: 'token-prod', secret: 'secret-prod' })).resolves.toBe(false);

        vi.resetModules();
        installServerProfilesMock();

        const reloaded = await import('./tokenStorage');
        await expect(reloaded.TokenStorage.getCredentials()).resolves.toBeNull();
    });

    it('does not hang boot credential reads when secure store misses and MMKV is unavailable', async () => {
        secureStoreState.getItemAsync.mockResolvedValue(null);
        vi.doMock('react-native-mmkv', async () => await new Promise(() => {}));

        const { TokenStorage } = await import('./tokenStorage');
        const timeoutToken = Symbol('timeout');
        const result = await Promise.race([
            TokenStorage.getCredentials(),
            new Promise<symbol>((resolve) => {
                setTimeout(() => resolve(timeoutToken), 50);
            }),
        ]);

        expect(result).toBeNull();
    });

    it('clears same-URL credentials for every server profile during global logout', async () => {
        serverProfilesState.activeServerId = 'server-a';
        serverProfilesState.activeServerUrl = 'https://shared.example.test';
        serverProfilesState.profiles = [
            { id: 'server-a', serverUrl: 'https://shared.example.test' },
            { id: 'server-b', serverUrl: 'https://shared.example.test' },
        ];

        const { TokenStorage } = await import('./tokenStorage');

        await expect(TokenStorage.setCredentials({ token: 'token-a', secret: 'secret-a' })).resolves.toBe(true);

        serverProfilesState.activeServerId = 'server-b';
        await expect(TokenStorage.setCredentials({ token: 'token-b', secret: 'secret-b' })).resolves.toBe(true);

        serverProfilesState.activeServerId = 'server-a';
        await expect(TokenStorage.removeCredentials()).resolves.toBe(true);

        await expect(TokenStorage.getCredentialsForServerUrl(serverProfilesState.activeServerUrl, { serverId: 'server-a' })).resolves.toBeNull();
        await expect(TokenStorage.getCredentialsForServerUrl(serverProfilesState.activeServerUrl, { serverId: 'server-b' })).resolves.toBeNull();
    });
});
