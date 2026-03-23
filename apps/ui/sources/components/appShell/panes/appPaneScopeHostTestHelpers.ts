import { vi } from 'vitest';

type PaneDimensions = Readonly<{
    width: number;
    height: number;
}>;

type AppPaneScopeHostImportOriginal = <T = unknown>() => Promise<T>;
type AppPaneScopeHostReactNativeModuleFactory = () => unknown | Promise<unknown>;
type AppPaneScopeHostStorageModuleFactory = (
    importOriginal: AppPaneScopeHostImportOriginal,
) => unknown | Promise<unknown>;

type InstallAppPaneScopeHostCommonModuleMocksOptions = Readonly<{
    getDimensions?: () => PaneDimensions;
    getLocalSetting?: (key: string) => unknown;
    reactNative?: AppPaneScopeHostReactNativeModuleFactory;
    storage?: AppPaneScopeHostStorageModuleFactory;
}>;

const appPaneScopeHostModuleState = vi.hoisted(() => ({
    options: {
        getDimensions: undefined as (() => PaneDimensions) | undefined,
        getLocalSetting: undefined as ((key: string) => unknown) | undefined,
        reactNative: undefined as AppPaneScopeHostReactNativeModuleFactory | undefined,
        storage: undefined as AppPaneScopeHostStorageModuleFactory | undefined,
    },
}));

export function installAppPaneScopeHostCommonModuleMocks(
    options: InstallAppPaneScopeHostCommonModuleMocksOptions = {},
) {
    appPaneScopeHostModuleState.options = {
        getDimensions: options.getDimensions,
        getLocalSetting: options.getLocalSetting,
        reactNative: options.reactNative,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = appPaneScopeHostModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: Record<string, unknown>) => value.web ?? value.default,
            },
            View: 'View',
            useWindowDimensions: () => activeOptions.getDimensions?.() ?? { width: 1200, height: 900 },
        });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = appPaneScopeHostModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => activeOptions.getLocalSetting?.(key) ?? null,
            useLocalSettingMutable: () => [null, vi.fn()],
        });
    });
}
