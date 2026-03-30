import { vi } from 'vitest';

type ModalComponentModuleFactory = () => unknown | Promise<unknown>;

type InstallModalComponentCommonModuleMocksOptions = Readonly<{
    reactNative?: ModalComponentModuleFactory;
    text?: ModalComponentModuleFactory;
    unistyles?: ModalComponentModuleFactory;
}>;

const modalComponentModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ModalComponentModuleFactory | undefined,
        text: undefined as ModalComponentModuleFactory | undefined,
        unistyles: undefined as ModalComponentModuleFactory | undefined,
    },
}));

export function installModalComponentCommonModuleMocks(
    options: InstallModalComponentCommonModuleMocksOptions = {},
) {
    modalComponentModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = modalComponentModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = modalComponentModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = modalComponentModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
