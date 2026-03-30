import { vi } from 'vitest';

type SystemUtilityModuleFactory = () => unknown | Promise<unknown>;

type InstallSystemUtilityCommonModuleMocksOptions = Readonly<{
    modal?: SystemUtilityModuleFactory;
    storage?: SystemUtilityModuleFactory;
    text?: SystemUtilityModuleFactory;
}>;

const systemUtilityModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SystemUtilityModuleFactory | undefined,
        storage: undefined as SystemUtilityModuleFactory | undefined,
        text: undefined as SystemUtilityModuleFactory | undefined,
    },
}));

vi.mock('@/modal', async () => {
    const activeOptions = systemUtilityModuleState.options;
    if (activeOptions.modal) {
        return await activeOptions.modal();
    }

    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const activeOptions = systemUtilityModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage();
    }

    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

vi.mock('@/text', async () => {
    const activeOptions = systemUtilityModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

export function installSystemUtilityCommonModuleMocks(
    options: InstallSystemUtilityCommonModuleMocksOptions = {},
): void {
    systemUtilityModuleState.options = {
        modal: options.modal,
        storage: options.storage,
        text: options.text,
    };
}
