import { mergeModuleMock, type MergeModuleMockOptions } from './_shared';

type ServerScopedMachineRpcModule = typeof import(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc'
);
type ServerScopedSessionRpcModule = typeof import(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc'
);
type ResolveServerIdForSessionIdFromLocalCacheModule = typeof import(
    '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache'
);
type ResolvePreferredServerIdForSessionIdModule = typeof import(
    '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId'
);

export type CreateServerScopedMachineRpcModuleMockOptions =
    MergeModuleMockOptions<ServerScopedMachineRpcModule>;
export type CreateServerScopedSessionRpcModuleMockOptions =
    MergeModuleMockOptions<ServerScopedSessionRpcModule>;
export type CreateResolveServerIdForSessionIdFromLocalCacheModuleMockOptions =
    MergeModuleMockOptions<ResolveServerIdForSessionIdFromLocalCacheModule>;

export async function createServerScopedMachineRpcModuleMock(
    options: CreateServerScopedMachineRpcModuleMockOptions,
): Promise<ServerScopedMachineRpcModule> {
    return mergeModuleMock<ServerScopedMachineRpcModule>(options);
}

export async function createServerScopedSessionRpcModuleMock(
    options: CreateServerScopedSessionRpcModuleMockOptions,
): Promise<ServerScopedSessionRpcModule> {
    return mergeModuleMock<ServerScopedSessionRpcModule>(options);
}

export function installServerScopedMachineRpcModuleMock(
    overrides: Partial<ServerScopedMachineRpcModule>,
) {
    return async (importOriginal: <T>() => Promise<T>) =>
        createServerScopedMachineRpcModuleMock({
            importOriginal,
            overrides,
        });
}

export function installServerScopedSessionRpcModuleMock(
    overrides: Partial<ServerScopedSessionRpcModule>,
) {
    return async (importOriginal: <T>() => Promise<T>) =>
        createServerScopedSessionRpcModuleMock({
            importOriginal,
            overrides,
        });
}
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
