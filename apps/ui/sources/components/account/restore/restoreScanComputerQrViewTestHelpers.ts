import { vi } from 'vitest';

type RestoreScanComputerQrViewModuleFactory = () => unknown | Promise<unknown>;

type InstallRestoreScanComputerQrViewCommonModuleMocksOptions = Readonly<{
    modal?: RestoreScanComputerQrViewModuleFactory;
    reactNative?: RestoreScanComputerQrViewModuleFactory;
    reactNavigation?: RestoreScanComputerQrViewModuleFactory;
    router?: RestoreScanComputerQrViewModuleFactory;
    text?: RestoreScanComputerQrViewModuleFactory;
    unistyles?: RestoreScanComputerQrViewModuleFactory;
}>;

const restoreScanComputerQrViewModuleState = vi.hoisted(() => ({
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    options: {
        modal: undefined as RestoreScanComputerQrViewModuleFactory | undefined,
        reactNative: undefined as RestoreScanComputerQrViewModuleFactory | undefined,
        reactNavigation: undefined as RestoreScanComputerQrViewModuleFactory | undefined,
        router: undefined as RestoreScanComputerQrViewModuleFactory | undefined,
        text: undefined as RestoreScanComputerQrViewModuleFactory | undefined,
        unistyles: undefined as RestoreScanComputerQrViewModuleFactory | undefined,
    },
}));

export function resetRestoreScanComputerQrViewCommonModuleMockState() {
    restoreScanComputerQrViewModuleState.routerBackSpy.mockClear();
    restoreScanComputerQrViewModuleState.routerPushSpy.mockClear();
    restoreScanComputerQrViewModuleState.routerReplaceSpy.mockClear();
}

export function installRestoreScanComputerQrViewCommonModuleMocks(
    options: InstallRestoreScanComputerQrViewCommonModuleMocksOptions = {},
) {
    restoreScanComputerQrViewModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        reactNavigation: options.reactNavigation,
        router: options.router,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native-reanimated', () => ({}));

    vi.mock('react-native', async () => {
        const activeOptions = restoreScanComputerQrViewModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = restoreScanComputerQrViewModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                back: restoreScanComputerQrViewModuleState.routerBackSpy,
                push: restoreScanComputerQrViewModuleState.routerPushSpy,
                replace: restoreScanComputerQrViewModuleState.routerReplaceSpy,
            },
        });
        return routerMock.module;
    });

    vi.mock('@react-navigation/native', async () => {
        const activeOptions = restoreScanComputerQrViewModuleState.options;
        if (activeOptions.reactNavigation) {
            return await activeOptions.reactNavigation();
        }

        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return createReactNavigationNativeMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = restoreScanComputerQrViewModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = restoreScanComputerQrViewModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = restoreScanComputerQrViewModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#fff',
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    overlay: {
                        scrim: 'rgba(0,0,0,0.3)',
                        scrimStrong: 'rgba(0,0,0,0.55)',
                        text: '#fff',
                        textSecondary: 'rgba(255,255,255,0.85)',
                    },
                },
            },
        });
    });

    vi.mock('@/components/ui/text/Text', () => ({
        Text: 'Text',
    }));

    vi.mock('@/components/ui/buttons/RoundButton', () => ({
        RoundButton: 'RoundButton',
    }));
}

export { restoreScanComputerQrViewModuleState };
