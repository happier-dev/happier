import { vi } from 'vitest';

type VoiceSessionBindingModuleFactory = () => unknown | Promise<unknown>;

type InstallVoiceSessionBindingCommonModuleMocksOptions = Readonly<{
    storage?: VoiceSessionBindingModuleFactory;
}>;

const voiceSessionBindingModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as VoiceSessionBindingModuleFactory | undefined,
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

export function installVoiceSessionBindingCommonModuleMocks(
    options: InstallVoiceSessionBindingCommonModuleMocksOptions = {},
): void {
    voiceSessionBindingModuleState.options = {
        storage: options.storage,
    };
}
