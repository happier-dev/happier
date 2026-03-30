import { vi } from 'vitest';

type VoiceSettingsPanelModuleFactory = () => unknown | Promise<unknown>;
type VoiceSettingsPanelStorageFactory = (
    importOriginal: () => Promise<typeof import('@/sync/domains/state/storage')>,
) => unknown | Promise<unknown>;

type InstallVoiceSettingsPanelCommonModuleMocksOptions = Readonly<{
    icons?: VoiceSettingsPanelModuleFactory;
    modal?: VoiceSettingsPanelModuleFactory;
    reactNative?: VoiceSettingsPanelModuleFactory;
    storage?: VoiceSettingsPanelStorageFactory;
    text?: VoiceSettingsPanelModuleFactory;
    unistyles?: VoiceSettingsPanelModuleFactory;
}>;

const voiceSettingsPanelModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as VoiceSettingsPanelModuleFactory | undefined,
        modal: undefined as VoiceSettingsPanelModuleFactory | undefined,
        reactNative: undefined as VoiceSettingsPanelModuleFactory | undefined,
        storage: undefined as VoiceSettingsPanelStorageFactory | undefined,
        text: undefined as VoiceSettingsPanelModuleFactory | undefined,
        unistyles: undefined as VoiceSettingsPanelModuleFactory | undefined,
    },
}));

export function installVoiceSettingsPanelCommonModuleMocks(
    options: InstallVoiceSettingsPanelCommonModuleMocksOptions = {},
) {
    voiceSettingsPanelModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = voiceSettingsPanelModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        return {
            Ionicons: 'Ionicons',
        };
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = voiceSettingsPanelModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = voiceSettingsPanelModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = voiceSettingsPanelModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});
}
