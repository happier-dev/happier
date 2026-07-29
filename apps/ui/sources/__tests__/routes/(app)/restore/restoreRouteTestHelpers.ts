import { vi } from 'vitest';

type ModuleFactory = () => unknown | Promise<unknown>;

type InstallRestoreRouteModuleMocksOptions = Readonly<{
    icons?: ModuleFactory;
    reactNative?: ModuleFactory;
    router?: ModuleFactory;
    modal?: ModuleFactory;
    text?: ModuleFactory;
    unistyles?: ModuleFactory;
}>;

const restoreRouteTestState = vi.hoisted(() => ({
    options: {
        icons: undefined as ModuleFactory | undefined,
        reactNative: undefined as ModuleFactory | undefined,
        router: undefined as ModuleFactory | undefined,
        modal: undefined as ModuleFactory | undefined,
        text: undefined as ModuleFactory | undefined,
        unistyles: undefined as ModuleFactory | undefined,
    },
}));

export function resetRestoreRouteTestState() {
    restoreRouteTestState.options = {
        icons: undefined,
        reactNative: undefined,
        router: undefined,
        modal: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installRestoreRouteCommonModuleMocks(
    options: InstallRestoreRouteModuleMocksOptions = {},
) {
    restoreRouteTestState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        router: options.router,
        modal: options.modal,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native-reanimated', async () => {
        const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
        return createReanimatedModuleMock();
    });

    vi.mock('@react-navigation/native', async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return createReactNavigationNativeMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        if (restoreRouteTestState.options.icons) {
            return await restoreRouteTestState.options.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@expo/vector-icons/Ionicons', async () => {
        const icons = restoreRouteTestState.options.icons
            ? await restoreRouteTestState.options.icons()
            : await (async () => {
                const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
                return createExpoVectorIconsMock();
            })();
        const Ionicons =
            icons && typeof icons === 'object' && 'Ionicons' in icons
                ? (icons as { Ionicons?: unknown }).Ionicons
                : undefined;

        return {
            ...(icons && typeof icons === 'object' ? icons : {}),
            default: Ionicons ?? 'Ionicons',
        };
    });

    vi.mock('react-native', async () => {
        if (restoreRouteTestState.options.reactNative) {
            return await restoreRouteTestState.options.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        if (restoreRouteTestState.options.router) {
            return await restoreRouteTestState.options.router();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/modal', async () => {
        if (restoreRouteTestState.options.modal) {
            return await restoreRouteTestState.options.modal();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        if (restoreRouteTestState.options.text) {
            return await restoreRouteTestState.options.text();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        if (restoreRouteTestState.options.unistyles) {
            return await restoreRouteTestState.options.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
