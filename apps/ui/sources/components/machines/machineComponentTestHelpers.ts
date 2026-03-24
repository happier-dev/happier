import { vi } from 'vitest';

type MachineComponentModuleFactory = () => unknown | Promise<unknown>;

type InstallMachineComponentCommonModuleMocksOptions = Readonly<{
    icons?: MachineComponentModuleFactory;
    modal?: MachineComponentModuleFactory;
    reactNative?: MachineComponentModuleFactory;
    text?: MachineComponentModuleFactory;
    unistyles?: MachineComponentModuleFactory;
}>;

const machineComponentModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as MachineComponentModuleFactory | undefined,
        modal: undefined as MachineComponentModuleFactory | undefined,
        reactNative: undefined as MachineComponentModuleFactory | undefined,
        text: undefined as MachineComponentModuleFactory | undefined,
        unistyles: undefined as MachineComponentModuleFactory | undefined,
    },
}));

export function installMachineComponentCommonModuleMocks(
    options: InstallMachineComponentCommonModuleMocksOptions = {},
) {
    machineComponentModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = machineComponentModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = machineComponentModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = machineComponentModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = machineComponentModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = machineComponentModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
