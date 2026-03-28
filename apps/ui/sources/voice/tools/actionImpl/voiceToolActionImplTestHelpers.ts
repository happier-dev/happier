import { vi } from 'vitest';

type VoiceToolActionImplModuleFactory = () => unknown | Promise<unknown>;

type InstallVoiceToolActionImplCommonModuleMocksOptions = Readonly<{
    modal?: VoiceToolActionImplModuleFactory;
    router?: VoiceToolActionImplModuleFactory;
    storage?: VoiceToolActionImplModuleFactory;
}>;

const voiceToolActionImplModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as VoiceToolActionImplModuleFactory | undefined,
        router: undefined as VoiceToolActionImplModuleFactory | undefined,
        storage: undefined as VoiceToolActionImplModuleFactory | undefined,
    },
}));

export function installVoiceToolActionImplCommonModuleMocks(
    options: InstallVoiceToolActionImplCommonModuleMocksOptions = {},
): void {
    voiceToolActionImplModuleState.options = {
        modal: options.modal,
        router: options.router,
        storage: options.storage,
    };

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = voiceToolActionImplModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });

    vi.mock('@/modal', async () => {
        const activeOptions = voiceToolActionImplModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = voiceToolActionImplModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });
}
