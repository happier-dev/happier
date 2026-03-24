import { vi } from 'vitest';

type CodeBlockModuleFactory = () => unknown | Promise<unknown>;

type InstallCodeBlockCommonModuleMocksOptions = Readonly<{
    modal?: CodeBlockModuleFactory;
    reactNative?: CodeBlockModuleFactory;
    text?: CodeBlockModuleFactory;
    unistyles?: CodeBlockModuleFactory;
}>;

const codeBlockModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as CodeBlockModuleFactory | undefined,
        reactNative: undefined as CodeBlockModuleFactory | undefined,
        text: undefined as CodeBlockModuleFactory | undefined,
        unistyles: undefined as CodeBlockModuleFactory | undefined,
    },
}));

export function installCodeBlockCommonModuleMocks(
    options: InstallCodeBlockCommonModuleMocksOptions = {},
) {
    codeBlockModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = codeBlockModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = codeBlockModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = codeBlockModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = codeBlockModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
