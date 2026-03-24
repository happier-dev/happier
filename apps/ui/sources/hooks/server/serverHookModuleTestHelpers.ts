import { vi } from 'vitest';

type ServerHookModuleFactory = () => unknown | Promise<unknown>;

type InstallServerHookCommonModuleMocksOptions = Readonly<{
    storage?: ServerHookModuleFactory;
}>;

const serverHookModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as ServerHookModuleFactory | undefined,
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const activeOptions = serverHookModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage();
    }

    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

export function installServerHookCommonModuleMocks(
    options: InstallServerHookCommonModuleMocksOptions = {},
): void {
    serverHookModuleState.options = {
        storage: options.storage,
    };
}
