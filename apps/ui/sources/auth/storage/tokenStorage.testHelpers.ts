import { vi } from 'vitest';

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
