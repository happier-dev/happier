import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type ResolveServerIdForSessionIdFromLocalCacheModule = typeof import(
    '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache'
);
type ResolvePreferredServerIdForSessionIdModule = typeof import(
    '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId'
);

export type CreateResolveServerIdForSessionIdFromLocalCacheModuleMockOptions =
    MergeModuleMockOptions<ResolveServerIdForSessionIdFromLocalCacheModule>;
export type CreateResolvePreferredServerIdForSessionIdModuleMockOptions =
    MergeModuleMockOptions<ResolvePreferredServerIdForSessionIdModule>;

export async function createResolveServerIdForSessionIdFromLocalCacheModuleMock(
    options: CreateResolveServerIdForSessionIdFromLocalCacheModuleMockOptions,
): Promise<ResolveServerIdForSessionIdFromLocalCacheModule> {
    return mergeModuleMock<ResolveServerIdForSessionIdFromLocalCacheModule>(options);
}

export async function createResolvePreferredServerIdForSessionIdModuleMock(
    options: CreateResolvePreferredServerIdForSessionIdModuleMockOptions,
): Promise<ResolvePreferredServerIdForSessionIdModule> {
    return mergeModuleMock<ResolvePreferredServerIdForSessionIdModule>(options);
}

export function installResolveServerIdForSessionIdFromLocalCacheModuleMock(
    overrides: Partial<ResolveServerIdForSessionIdFromLocalCacheModule>,
) {
    return async (importOriginal: <T>() => Promise<T>) =>
        createResolveServerIdForSessionIdFromLocalCacheModuleMock({
            importOriginal,
            overrides,
        });
}

export function installResolvePreferredServerIdForSessionIdModuleMock(
    overrides: Partial<ResolvePreferredServerIdForSessionIdModule>,
) {
    return async (importOriginal: <T>() => Promise<T>) =>
        createResolvePreferredServerIdForSessionIdModuleMock({
            importOriginal,
            overrides,
        });
}
