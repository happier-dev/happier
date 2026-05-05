import { vi } from 'vitest';

type NavigationShellModuleFactory = () => unknown | Promise<unknown>;
type NavigationShellImportOriginal = <T = unknown>() => Promise<T>;
type NavigationShellStorageModuleFactory = (
    importOriginal: NavigationShellImportOriginal,
) => unknown | Promise<unknown>;

type InstallNavigationShellCommonModuleMocksOptions = Readonly<{
    appPaneProvider?: NavigationShellModuleFactory;
    modal?: NavigationShellModuleFactory;
    reactNative?: NavigationShellModuleFactory;
    router?: NavigationShellModuleFactory;
    storage?: NavigationShellStorageModuleFactory;
    text?: NavigationShellModuleFactory;
    unistyles?: NavigationShellModuleFactory;
}>;

const navigationShellModuleState = vi.hoisted(() => ({
    options: {
        appPaneProvider: undefined as NavigationShellModuleFactory | undefined,
        modal: undefined as NavigationShellModuleFactory | undefined,
        reactNative: undefined as NavigationShellModuleFactory | undefined,
        router: undefined as NavigationShellModuleFactory | undefined,
        storage: undefined as NavigationShellStorageModuleFactory | undefined,
        text: undefined as NavigationShellModuleFactory | undefined,
        unistyles: undefined as NavigationShellModuleFactory | undefined,
    },
}));

export function installNavigationShellCommonModuleMocks(
    options: InstallNavigationShellCommonModuleMocksOptions = {},
) {
    navigationShellModuleState.options = {
        appPaneProvider: options.appPaneProvider,
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = navigationShellModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = navigationShellModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = navigationShellModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = navigationShellModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = navigationShellModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = navigationShellModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/components/appShell/panes/AppPaneProvider', async () => {
        const activeOptions = navigationShellModuleState.options;
        if (activeOptions.appPaneProvider) {
            return await activeOptions.appPaneProvider();
        }

        return {
            useAppPaneContext: () => ({
                dispatch: vi.fn(),
                state: {
                    activeScopeId: null,
                    focusMode: { scopeId: null },
                    scopes: {},
                },
                getDriver: () => null,
                driverRegistryVersion: 1,
                registerDriver: () => () => {},
            }),
        };
    });
}
