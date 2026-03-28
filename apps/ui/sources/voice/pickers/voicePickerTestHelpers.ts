import { vi } from 'vitest';

type VoicePickerModuleFactory = () => unknown | Promise<unknown>;
type VoicePickerImportOriginal = <T = unknown>() => Promise<T>;
type VoicePickerStorageModuleFactory = (
    importOriginal: VoicePickerImportOriginal,
) => unknown | Promise<unknown>;

type InstallVoicePickerCommonModuleMocksOptions = Readonly<{
    reactNative?: VoicePickerModuleFactory;
    storage?: VoicePickerStorageModuleFactory;
    text?: VoicePickerModuleFactory;
    unistyles?: VoicePickerModuleFactory;
}>;

const voicePickerModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as VoicePickerModuleFactory | undefined,
        storage: undefined as VoicePickerStorageModuleFactory | undefined,
        text: undefined as VoicePickerModuleFactory | undefined,
        unistyles: undefined as VoicePickerModuleFactory | undefined,
    },
}));

export function installVoicePickerCommonModuleMocks(
    options: InstallVoicePickerCommonModuleMocksOptions = {},
): void {
    voicePickerModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                    ScrollView: 'ScrollView',
                    Platform: {
                        OS: 'web',
                        select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
                    },
                }
    );
});

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = voicePickerModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = voicePickerModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = voicePickerModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });
}
