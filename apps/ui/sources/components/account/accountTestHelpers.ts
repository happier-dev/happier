import { vi } from 'vitest';

type AccountModuleFactory = () => unknown | Promise<unknown>;

type InstallAccountCommonModuleMocksOptions = Readonly<{
    icons?: AccountModuleFactory;
    modal?: AccountModuleFactory;
    reactNative?: AccountModuleFactory;
    router?: AccountModuleFactory;
    text?: AccountModuleFactory;
    unistyles?: AccountModuleFactory;
}>;

const accountModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as AccountModuleFactory | undefined,
        modal: undefined as AccountModuleFactory | undefined,
        reactNative: undefined as AccountModuleFactory | undefined,
        router: undefined as AccountModuleFactory | undefined,
        text: undefined as AccountModuleFactory | undefined,
        unistyles: undefined as AccountModuleFactory | undefined,
    },
}));

export function installAccountCommonModuleMocks(
    options: InstallAccountCommonModuleMocksOptions = {},
) {
    accountModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native-reanimated', () => ({}));

    vi.mock('react-native', async () => {
        const activeOptions = accountModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = accountModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = accountModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = accountModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/modal', async () => {
        const activeOptions = accountModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = accountModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
