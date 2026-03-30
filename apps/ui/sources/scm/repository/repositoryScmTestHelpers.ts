import { vi } from 'vitest';

type RepositoryScmModuleFactory = () => unknown | Promise<unknown>;
type RepositoryScmImportOriginal = <T = unknown>() => Promise<T>;
type RepositoryScmStorageModuleFactory = (
    importOriginal: RepositoryScmImportOriginal,
) => unknown | Promise<unknown>;

type InstallRepositoryScmCommonModuleMocksOptions = Readonly<{
    storage?: RepositoryScmStorageModuleFactory;
}>;

const repositoryScmModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as RepositoryScmStorageModuleFactory | undefined,
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const activeOptions = repositoryScmModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage(importOriginal);
    }

    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {});
});

export function installRepositoryScmCommonModuleMocks(
    options: InstallRepositoryScmCommonModuleMocksOptions = {},
): void {
    repositoryScmModuleState.options = {
        storage: options.storage,
    };
}
