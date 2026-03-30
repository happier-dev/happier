import { vi } from 'vitest';

type EmbeddedTerminalPaneModuleFactory = () => unknown | Promise<unknown>;

type InstallEmbeddedTerminalPaneCommonModuleMocksOptions = Readonly<{
    reactNative?: EmbeddedTerminalPaneModuleFactory;
    text?: EmbeddedTerminalPaneModuleFactory;
    unistyles?: EmbeddedTerminalPaneModuleFactory;
}>;

const embeddedTerminalPaneModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as EmbeddedTerminalPaneModuleFactory | undefined,
        text: undefined as EmbeddedTerminalPaneModuleFactory | undefined,
        unistyles: undefined as EmbeddedTerminalPaneModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = embeddedTerminalPaneModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = embeddedTerminalPaneModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const activeOptions = embeddedTerminalPaneModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

export function installEmbeddedTerminalPaneCommonModuleMocks(
    options: InstallEmbeddedTerminalPaneCommonModuleMocksOptions = {},
): void {
    embeddedTerminalPaneModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };
}
