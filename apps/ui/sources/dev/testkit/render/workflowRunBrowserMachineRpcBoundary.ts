import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

// Preserve the real dispatch-order owner; only the other-process RPC reply is a fixture.
export { createOrderedMachineRpcCaller } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc.ts';

export async function machineRpcWithServerScope<R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> {
    const boundary = globalThis as typeof globalThis & {
        runBrowserMachineRpc: (request: Readonly<{ method: string; payload: unknown }>) => Promise<unknown>;
    };
    params.onDispatched?.();
    // The external daemon reply is deliberately untyped here; the real Action output schema validates it.
    return await boundary.runBrowserMachineRpc(params) as R;
}
