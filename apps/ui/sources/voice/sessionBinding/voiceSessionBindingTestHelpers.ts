import { vi } from 'vitest';

type VoiceSessionBindingImportOriginal = <T = unknown>() => Promise<T>;
type VoiceSessionBindingStorageModuleFactory = (
    importOriginal: VoiceSessionBindingImportOriginal,
) => unknown | Promise<unknown>;

type InstallVoiceSessionBindingCommonModuleMocksOptions = Readonly<{
    storage?: VoiceSessionBindingStorageModuleFactory;
}>;

const voiceSessionBindingModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as VoiceSessionBindingStorageModuleFactory | undefined,
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const activeOptions = voiceSessionBindingModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage(importOriginal);
    }

    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {});
});

export function installVoiceSessionBindingCommonModuleMocks(
    options: InstallVoiceSessionBindingCommonModuleMocksOptions = {},
): void {
    voiceSessionBindingModuleState.options = {
        storage: options.storage,
    };
}
