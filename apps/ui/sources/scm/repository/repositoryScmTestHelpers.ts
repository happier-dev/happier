import { vi } from 'vitest';

type RepositoryScmModuleFactory = () => unknown | Promise<unknown>;

type InstallRepositoryScmCommonModuleMocksOptions = Readonly<{
    storage?: RepositoryScmModuleFactory;
}>;

const repositoryScmModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as RepositoryScmModuleFactory | undefined,
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

export function installRepositoryScmCommonModuleMocks(
    options: InstallRepositoryScmCommonModuleMocksOptions = {},
): void {
    repositoryScmModuleState.options = {
        storage: options.storage,
    };
}
