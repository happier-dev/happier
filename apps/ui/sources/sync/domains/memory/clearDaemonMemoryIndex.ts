import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/** Clears one machine's derived memory index (including indexed native conversations); its settings stay. */
export async function clearDaemonMemoryIndex(args: Readonly<{ serverId: string; machineId: string }>): Promise<void> {
    await machineRpcWithServerScope<unknown, unknown>({
        machineId: args.machineId,
        serverId: args.serverId,
        method: RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX,
        payload: {},
    });
}
