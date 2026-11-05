import { afterEach, beforeEach, vi } from 'vitest';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

type TokenStorageModuleFactory = () => unknown | Promise<unknown>;

type InstallTokenStorageWebPlatformMocksOptions = Readonly<{
    reactNative?: TokenStorageModuleFactory;
    secureStore?: TokenStorageModuleFactory;
    asyncStorage?: TokenStorageModuleFactory;
}>;

const tokenStorageModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as TokenStorageModuleFactory | undefined,
        secureStore: undefined as TokenStorageModuleFactory | undefined,
        asyncStorage: undefined as TokenStorageModuleFactory | undefined,
    },
}));

export function installTokenStorageWebPlatformMocks(
    options: InstallTokenStorageWebPlatformMocksOptions = {},
) {
    tokenStorageModuleState.options = {
        reactNative: options.reactNative,
        secureStore: options.secureStore,
        asyncStorage: options.asyncStorage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = tokenStorageModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    });

    vi.mock('expo-secure-store', async () => {
        const activeOptions = tokenStorageModuleState.options;
        if (activeOptions.secureStore) {
            return await activeOptions.secureStore();
        }

        return {};
    });

    vi.mock('@react-native-async-storage/async-storage', async () => {
        const activeOptions = tokenStorageModuleState.options;
        if (activeOptions.asyncStorage) {
            return await activeOptions.asyncStorage();
        }

        return {
            default: {
                getItem: vi.fn(async () => null),
                setItem: vi.fn(async () => {}),
                removeItem: vi.fn(async () => {}),
            },
        };
    });
}

/**
 * Lets one TokenStorage module instance serve a whole file. Each test gets its own storage scope
 * (TokenStorage caches are keyed by the scoped storage key) and fresh read caches in the real Home
 * profile owner, which tests seed through `seedPersistedHomeProfilesForTests` instead of mocking it.
 * A second module instance is still the right tool for cross-tab and reload contracts.
 */
export function installTokenStorageTestIsolation(
    scopePrefix: string,
    profileResetOptions?: Parameters<typeof import('@/sync/domains/server/serverProfiles').resetServerProfilesRuntimeForTests>[0],
): void {
    const previousStorageScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let sequence = 0;
    // Bind the file's own profile owner before any test opens a second module instance with
    // `vi.resetModules()`; later imports would otherwise reset that newer instance instead.
    let serverProfiles: typeof import('@/sync/domains/server/serverProfiles') | null = null;
    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `${scopePrefix}_${sequence++}`;
        serverProfiles ??= await import('@/sync/domains/server/serverProfiles');
        serverProfiles.resetServerProfilesRuntimeForTests(profileResetOptions);
    });
    afterEach(() => {
        if (previousStorageScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousStorageScope;
    });
}

/** A persisted Home profile record for `seedPersistedHomeProfilesForTests`. */
export function homeProfileForTests(
    id: string,
    serverUrl: string,
    extra: Partial<Omit<ServerProfile, 'id' | 'serverUrl'>> = {},
): ServerProfile {
    return { id, name: id, serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1, ...extra };
}
