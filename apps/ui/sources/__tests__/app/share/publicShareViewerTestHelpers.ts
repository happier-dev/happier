import { vi } from 'vitest';

type PublicShareViewerModuleFactory = () => unknown | Promise<unknown>;

type InstallPublicShareViewerCommonModuleMocksOptions = Readonly<{
    reactNative?: PublicShareViewerModuleFactory;
    router?: PublicShareViewerModuleFactory;
    text?: PublicShareViewerModuleFactory;
    unistyles?: PublicShareViewerModuleFactory;
}>;

const publicShareViewerModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as PublicShareViewerModuleFactory | undefined,
        router: undefined as PublicShareViewerModuleFactory | undefined,
        text: undefined as PublicShareViewerModuleFactory | undefined,
        unistyles: undefined as PublicShareViewerModuleFactory | undefined,
    },
}));

export function installPublicShareViewerCommonModuleMocks(
    options: InstallPublicShareViewerCommonModuleMocksOptions = {},
): void {
    publicShareViewerModuleState.options = {
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('expo-router', async () => {
        const activeOptions = publicShareViewerModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            params: { token: 'tok-1' },
        }).module;
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = publicShareViewerModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = publicShareViewerModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
