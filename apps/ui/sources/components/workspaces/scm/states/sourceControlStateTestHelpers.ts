import { vi } from 'vitest';

type SourceControlStateModuleFactory = () => unknown | Promise<unknown>;

type InstallSourceControlStateCommonModuleMocksOptions = Readonly<{
    reactNative?: SourceControlStateModuleFactory;
    text?: SourceControlStateModuleFactory;
    uiText?: SourceControlStateModuleFactory;
    unistyles?: SourceControlStateModuleFactory;
}>;

const sourceControlStateModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SourceControlStateModuleFactory | undefined,
        text: undefined as SourceControlStateModuleFactory | undefined,
        uiText: undefined as SourceControlStateModuleFactory | undefined,
        unistyles: undefined as SourceControlStateModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = sourceControlStateModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = sourceControlStateModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const activeOptions = sourceControlStateModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const activeOptions = sourceControlStateModuleState.options;
    if (activeOptions.uiText) {
        return await activeOptions.uiText();
    }

    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

export function installSourceControlStateCommonModuleMocks(
    options: InstallSourceControlStateCommonModuleMocksOptions = {},
): void {
    sourceControlStateModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        uiText: options.uiText,
        unistyles: options.unistyles,
    };
}
