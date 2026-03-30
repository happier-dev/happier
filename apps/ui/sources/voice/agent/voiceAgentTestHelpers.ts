import { vi } from 'vitest';

type VoiceAgentModuleFactory = () => unknown | Promise<unknown>;
type VoiceAgentImportOriginal = <T = unknown>() => Promise<T>;
type VoiceAgentStorageModuleFactory = (
    importOriginal: VoiceAgentImportOriginal,
) => unknown | Promise<unknown>;

type InstallVoiceAgentCommonModuleMocksOptions = Readonly<{
    modal?: VoiceAgentModuleFactory;
    storage?: VoiceAgentStorageModuleFactory;
}>;

const voiceAgentModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as VoiceAgentModuleFactory | undefined,
        storage: undefined as VoiceAgentStorageModuleFactory | undefined,
    },
}));

export function installVoiceAgentCommonModuleMocks(
    options: InstallVoiceAgentCommonModuleMocksOptions = {},
): void {
    voiceAgentModuleState.options = {
        modal: options.modal,
        storage: options.storage,
    };

    vi.mock('@/modal', async () => {
        const activeOptions = voiceAgentModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = voiceAgentModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });
}
