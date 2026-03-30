import { vi } from 'vitest';

type VoiceQaModuleFactory = () => unknown | Promise<unknown>;

type InstallVoiceQaCommonModuleMocksOptions = Readonly<{
    reactNative?: VoiceQaModuleFactory;
    text?: VoiceQaModuleFactory;
    unistyles?: VoiceQaModuleFactory;
}>;

const voiceQaModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as VoiceQaModuleFactory | undefined,
        text: undefined as VoiceQaModuleFactory | undefined,
        unistyles: undefined as VoiceQaModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = voiceQaModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = voiceQaModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const activeOptions = voiceQaModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

export function installVoiceQaCommonModuleMocks(
    options: InstallVoiceQaCommonModuleMocksOptions = {},
): void {
    voiceQaModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        unistyles: options.unistyles,
    };
}
