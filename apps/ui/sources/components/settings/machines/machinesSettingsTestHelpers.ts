import { vi } from 'vitest';

type MachinesSettingsModuleFactory = () => unknown | Promise<unknown>;

type InstallMachinesSettingsCommonModuleMocksOptions = Readonly<{
    modal?: MachinesSettingsModuleFactory;
    reactNative?: MachinesSettingsModuleFactory;
    router?: MachinesSettingsModuleFactory;
    text?: MachinesSettingsModuleFactory;
    unistyles?: MachinesSettingsModuleFactory;
}>;

const machinesSettingsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as MachinesSettingsModuleFactory | undefined,
        reactNative: undefined as MachinesSettingsModuleFactory | undefined,
        router: undefined as MachinesSettingsModuleFactory | undefined,
        text: undefined as MachinesSettingsModuleFactory | undefined,
        unistyles: undefined as MachinesSettingsModuleFactory | undefined,
    },
}));

export function installMachinesSettingsCommonModuleMocks(
    options: InstallMachinesSettingsCommonModuleMocksOptions = {},
) {
    machinesSettingsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = machinesSettingsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = machinesSettingsModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = machinesSettingsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = machinesSettingsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = machinesSettingsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
