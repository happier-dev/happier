import { vi } from 'vitest';

type FormsModuleFactory = () => unknown | Promise<unknown>;

type InstallFormsCommonModuleMocksOptions = Readonly<{
    reactNative?: FormsModuleFactory;
    text?: FormsModuleFactory;
    unistyles?: FormsModuleFactory;
}>;

const formsModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as FormsModuleFactory | undefined,
        text: undefined as FormsModuleFactory | undefined,
        unistyles: undefined as FormsModuleFactory | undefined,
    },
}));

export function installFormsCommonModuleMocks(
    options: InstallFormsCommonModuleMocksOptions = {},
) {
    formsModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = formsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = formsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = formsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
