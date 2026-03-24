import { vi } from 'vitest';

type NewSessionModulesModuleFactory = () => unknown | Promise<unknown>;

type InstallNewSessionModulesCommonModuleMocksOptions = Readonly<{
    modal?: NewSessionModulesModuleFactory;
    reactNative?: NewSessionModulesModuleFactory;
    text?: NewSessionModulesModuleFactory;
}>;

const newSessionModulesModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as NewSessionModulesModuleFactory | undefined,
        reactNative: undefined as NewSessionModulesModuleFactory | undefined,
        text: undefined as NewSessionModulesModuleFactory | undefined,
    },
}));

export function installNewSessionModulesCommonModuleMocks(
    options: InstallNewSessionModulesCommonModuleMocksOptions = {},
): void {
    newSessionModulesModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = newSessionModulesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = newSessionModulesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = newSessionModulesModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
