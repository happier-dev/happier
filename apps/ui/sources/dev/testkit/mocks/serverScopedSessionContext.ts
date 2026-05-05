import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type ServerScopedSessionContextModule = typeof import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext');

export type CreateServerScopedSessionContextModuleMockOptions = MergeModuleMockOptions<ServerScopedSessionContextModule>;

export async function createServerScopedSessionContextModuleMock(
    options: CreateServerScopedSessionContextModuleMockOptions,
): Promise<ServerScopedSessionContextModule> {
    return mergeModuleMock<ServerScopedSessionContextModule>(options);
}

export function installServerScopedSessionContextModuleMock(
    overrides: Partial<ServerScopedSessionContextModule>,
) {
    return async (importOriginal: <T>() => Promise<T>) => createServerScopedSessionContextModuleMock({
        importOriginal,
        overrides,
    });
}
