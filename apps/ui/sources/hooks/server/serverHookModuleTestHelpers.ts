import { vi } from 'vitest';

type ServerHookModuleFactory = () => unknown | Promise<unknown>;
type ServerHookImportOriginal = <T = unknown>() => Promise<T>;
type ServerHookStorageModuleFactory = (
    importOriginal: ServerHookImportOriginal,
) => unknown | Promise<unknown>;

type InstallServerHookCommonModuleMocksOptions = Readonly<{
    storage?: ServerHookStorageModuleFactory;
}>;

const serverHookModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as ServerHookStorageModuleFactory | undefined,
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const activeOptions = serverHookModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage(importOriginal);
    }

    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {});
});

export function installServerHookCommonModuleMocks(
    options: InstallServerHookCommonModuleMocksOptions = {},
): void {
    serverHookModuleState.options = {
        storage: options.storage,
    };
}
