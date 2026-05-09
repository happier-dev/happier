import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type PersistenceModule = typeof import('@/sync/domains/state/persistence');

export type CreatePersistenceModuleMockOptions = MergeModuleMockOptions<PersistenceModule>;
export type PersistenceModuleMockOverrides = Partial<PersistenceModule>;

export async function createPersistenceModuleMock(options: CreatePersistenceModuleMockOptions): Promise<PersistenceModule> {
    return mergeModuleMock<PersistenceModule>(options);
}

export function installPersistenceModuleMock(overrides: PersistenceModuleMockOverrides) {
    return async (importOriginal: <T>() => Promise<T>) => createPersistenceModuleMock({
        importOriginal,
        overrides,
    });
}
