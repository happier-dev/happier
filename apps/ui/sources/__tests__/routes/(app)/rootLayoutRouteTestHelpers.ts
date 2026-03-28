import { vi } from 'vitest';

type RootLayoutRouteModuleFactory = () => unknown | Promise<unknown>;
type RootLayoutRouteImportOriginal = <T = unknown>() => Promise<T>;
type RootLayoutRouteStorageModuleFactory = (
    importOriginal: RootLayoutRouteImportOriginal,
) => unknown | Promise<unknown>;

type InstallRootLayoutRouteCommonModuleMocksOptions = Readonly<{
    reactNative?: RootLayoutRouteModuleFactory;
    router?: RootLayoutRouteModuleFactory;
    storage?: RootLayoutRouteStorageModuleFactory;
    unistyles?: RootLayoutRouteModuleFactory;
    text?: RootLayoutRouteModuleFactory;
}>;

const rootLayoutRouteModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as RootLayoutRouteModuleFactory | undefined,
        router: undefined as RootLayoutRouteModuleFactory | undefined,
        storage: undefined as RootLayoutRouteStorageModuleFactory | undefined,
        unistyles: undefined as RootLayoutRouteModuleFactory | undefined,
        text: undefined as RootLayoutRouteModuleFactory | undefined,
    },
}));

export function installRootLayoutRouteCommonModuleMocks(
    options: InstallRootLayoutRouteCommonModuleMocksOptions = {},
) {
    rootLayoutRouteModuleState.options = {
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        unistyles: options.unistyles,
        text: options.text,
    };

    vi.mock('expo-router', async () => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/',
            segments: ['(app)'],
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    });

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Platform: {
                                OS: 'ios',
                                select: <T,>(choices: { ios?: T; default?: T; web?: T }) =>
                                    choices?.ios ?? choices?.default ?? choices?.web,
                            },
                            AppState: {
                                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
                            },
                        }
    );
});

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {},
        });
    });
}
