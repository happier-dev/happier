import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { FilesystemTransferActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

/** Uses the catalog's semantic RPC binding; the daemon owns admission and operation settlement. */
export async function callFilesystemTransferAction(params: Readonly<{
    actionId: FilesystemTransferActionId | 'daemon.filesystem.copy';
    machineId: string;
    serverId?: string | null;
    accountId?: string;
    input: unknown;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
}>): Promise<unknown> {
    const method = getActionSpec(params.actionId).bindings?.rpcMethod;
    if (!method) throw new Error('Filesystem transfer Action RPC binding is unavailable');
    return await callGuardedMachineRpcWithPolicy({ machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
        method, payload: { kind: 'targeted_action_rpc', target: { kind: 'machine', machineId: params.machineId }, input: params.input },
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        // The actual reader/destination remains mounted during blocking approval.
        // Setup keeps its existing budget; caller cancellation owns admission.
        ...(params.actionId !== 'daemon.filesystem.transfer.cancel' ? { operationTimeoutMs: null } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}
