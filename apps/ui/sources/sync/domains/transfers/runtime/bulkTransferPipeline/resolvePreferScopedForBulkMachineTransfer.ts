import { readServerEnabledBit } from '@happier-dev/protocol';

import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';

import { shouldPreferScopedMachineRpcForBulkTransfer } from './shouldPreferScopedMachineRpcForBulkTransfer';

export async function resolvePreferScopedForBulkMachineTransfer(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number | null;
}>): Promise<boolean> {
    // Consult shared feature gating before attempting any active-scope machine RPC.
    const serverFeatures = await getReadyServerFeatures({
        timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 500,
        serverId: typeof params.serverId === 'string' ? params.serverId : undefined,
    });

    // Fail closed for direct machine RPC attempts when the policy snapshot is unavailable or disables transfers.
    if (!serverFeatures) return true;
    if (readServerEnabledBit(serverFeatures, 'machines.transfer') !== true) return true;

    return shouldPreferScopedMachineRpcForBulkTransfer({
        serverId: params.serverId,
        machineId: params.machineId,
    });
}
