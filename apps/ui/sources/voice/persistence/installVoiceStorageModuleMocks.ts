import { vi } from 'vitest';

type VoiceStorageImportOriginal = <T = unknown>() => Promise<T>;
type VoiceStorageModuleFactory = (
    importOriginal: VoiceStorageImportOriginal,
) => unknown | Promise<unknown>;

type InstallVoiceStorageModuleMocksOptions = Readonly<{
    storage?: VoiceStorageModuleFactory;
}>;

const voiceStorageModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as VoiceStorageModuleFactory | undefined,
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const activeOptions = voiceStorageModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage(importOriginal);
    }

    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {});
});

export function installVoiceStorageModuleMocks(
    options: InstallVoiceStorageModuleMocksOptions = {},
): void {
    voiceStorageModuleState.options = {
        storage: options.storage,
    };
}
