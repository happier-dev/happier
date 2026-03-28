import { vi } from 'vitest';

type TranscriptMotionModuleFactory = () => unknown | Promise<unknown>;

type InstallTranscriptMotionCommonModuleMocksOptions = Readonly<{
    reactNative?: TranscriptMotionModuleFactory;
    uiText?: TranscriptMotionModuleFactory;
}>;

const transcriptMotionModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as TranscriptMotionModuleFactory | undefined,
        uiText: undefined as TranscriptMotionModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = transcriptMotionModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const activeOptions = transcriptMotionModuleState.options;
    if (activeOptions.uiText) {
        return await activeOptions.uiText();
    }

    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

export function installTranscriptMotionCommonModuleMocks(
    options: InstallTranscriptMotionCommonModuleMocksOptions = {},
): void {
    transcriptMotionModuleState.options = {
        reactNative: options.reactNative,
        uiText: options.uiText,
    };
}
