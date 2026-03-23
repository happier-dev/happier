import { vi } from 'vitest';

type SessionGuidanceModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionGuidanceCommonModuleMocksOptions = Readonly<{
    modal?: SessionGuidanceModuleFactory;
    reactNative?: SessionGuidanceModuleFactory;
    router?: SessionGuidanceModuleFactory;
    storage?: SessionGuidanceModuleFactory;
    text?: SessionGuidanceModuleFactory;
    unistyles?: SessionGuidanceModuleFactory;
}>;

const sessionGuidanceTranslations: Record<string, string> = {
    'components.emptyMainScreen.installCommand': '$ npm i -g @happier-dev/cli',
    'components.emptySessionsTablet.startNewSessionButton': 'Start New Session',
    'components.emptyMainScreen.openCamera': 'Open Camera',
    'connect.enterUrlManually': 'Enter URL manually',
};

const sessionGuidanceModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SessionGuidanceModuleFactory | undefined,
        reactNative: undefined as SessionGuidanceModuleFactory | undefined,
        router: undefined as SessionGuidanceModuleFactory | undefined,
        storage: undefined as SessionGuidanceModuleFactory | undefined,
        text: undefined as SessionGuidanceModuleFactory | undefined,
        unistyles: undefined as SessionGuidanceModuleFactory | undefined,
    },
}));

export function installSessionGuidanceCommonModuleMocks(
    options: InstallSessionGuidanceCommonModuleMocksOptions = {},
) {
    sessionGuidanceModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => sessionGuidanceTranslations[key] ?? key,
        });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: vi.fn() },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = sessionGuidanceModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useMachineListByServerId: () => ({ s1: [] }),
            useMachineListStatusByServerId: () => ({ s1: 'idle' }),
            useSetting: () => [],
        });
    });
}
