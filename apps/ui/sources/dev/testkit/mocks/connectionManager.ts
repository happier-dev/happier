import type { AppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/connectionManager';

/** Replace the applied network connection facts while retaining its real subscription contract. */
export async function createConnectionManagerModuleMock(
    importOriginal: <T>() => Promise<T>,
    options: Readonly<{ getSnapshot(): AppliedActiveServerSnapshot; runtimeAvailable?: boolean }>,
) {
    const actual = await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>();
    return {
        ...actual,
        getAppliedActiveServerSnapshot: options.getSnapshot,
        getAppliedActiveServerId: () => options.getSnapshot().serverId,
        isAppliedActiveServerRuntimeAvailable: () => options.runtimeAvailable ?? true,
    };
}
