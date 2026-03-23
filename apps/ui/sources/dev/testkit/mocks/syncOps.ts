import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type SyncOpsModule = typeof import('@/sync/ops');

export type CreateSyncOpsModuleMockOptions = MergeModuleMockOptions<SyncOpsModule>;

export async function createSyncOpsModuleMock(options: CreateSyncOpsModuleMockOptions): Promise<SyncOpsModule> {
    return mergeModuleMock<SyncOpsModule>(options);
}

export function installSyncOpsModuleMock(overrides: Partial<SyncOpsModule>) {
    return async (importOriginal: <T>() => Promise<T>) => createSyncOpsModuleMock({
        importOriginal,
        overrides,
    });
}
