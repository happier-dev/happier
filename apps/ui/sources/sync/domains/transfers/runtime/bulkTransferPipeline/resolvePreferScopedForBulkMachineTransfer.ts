import { readServerEnabledBit } from '@happier-dev/protocol';

import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { readCachedMachineRpcDirectRoute } from '@/sync/domains/transfers/runtime/transferRouteCache';
import { resolveTransferRouteDecision } from '@/sync/domains/transfers/runtime/transferSubstrate/resolveTransferRouteDecision';

export async function resolvePreferScopedForBulkMachineTransfer(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number | null;
}>): Promise<boolean> {
    try {
        // Consult shared feature gating before attempting any active-scope machine RPC.
        const serverFeatures = await getReadyServerFeatures({
            timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 500,
            serverId: typeof params.serverId === 'string' ? params.serverId : undefined,
        });

        // Fail closed for direct machine RPC attempts when the policy snapshot is unavailable or disables transfers.
        if (!serverFeatures) return true;
        if (readServerEnabledBit(serverFeatures, 'machines.transfer') !== true) return true;

        const decision = resolveTransferRouteDecision({
            serverFeatures,
            directPeerRoute: { status: 'unknown' },
            machineRpcDirectRoute: readCachedMachineRpcDirectRoute({
                serverId: params.serverId,
                remoteMachineId: params.machineId,
            }),
        });

        return decision.preferScopedMachineRpc;
    } catch {
        // Fail closed: if we cannot evaluate transfer policy, do not attempt `machine_rpc_direct`.
        return true;
    }
}
