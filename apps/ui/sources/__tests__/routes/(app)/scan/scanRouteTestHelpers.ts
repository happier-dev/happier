import * as React from 'react';
import { vi } from 'vitest';

type ScanRouteModuleFactory = () => unknown | Promise<unknown>;

type InstallScanRouteCommonModuleMocksOptions = Readonly<{
    reactNative?: ScanRouteModuleFactory;
    router?: ScanRouteModuleFactory;
    text?: ScanRouteModuleFactory;
    modal?: ScanRouteModuleFactory;
}>;

const scanRouteModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ScanRouteModuleFactory | undefined,
        router: undefined as ScanRouteModuleFactory | undefined,
        text: undefined as ScanRouteModuleFactory | undefined,
        modal: undefined as ScanRouteModuleFactory | undefined,
    },
}));

export function resetScanRouteTestState() {
    scanRouteModuleState.options = {
        reactNative: undefined,
        router: undefined,
        text: undefined,
        modal: undefined,
    };
}

export function installScanRouteCommonModuleMocks(
    options: InstallScanRouteCommonModuleMocksOptions = {},
) {
    scanRouteModuleState.options = {
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
        modal: options.modal,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                        }
    );
});

    vi.mock('@/text', async () => {
        const activeOptions = scanRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = scanRouteModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/components/ui/buttons/RoundButton', () => ({
        RoundButton: (props: any) => React.createElement('RoundButton', props, null),
    }));

    vi.mock('expo-router', async () => {
        const activeOptions = scanRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: vi.fn(),
                push: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    });
}
