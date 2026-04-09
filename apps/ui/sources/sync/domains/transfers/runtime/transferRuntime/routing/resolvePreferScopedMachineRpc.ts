import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { readCachedMachineRpcDirectRoute } from '@/sync/domains/transfers/runtime/transferRouteCache';

import { resolveTransferRouteDecision } from './resolveTransferRouteDecision';

export async function resolvePreferScopedMachineRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number | null;
}>): Promise<boolean> {
    try {
        const serverFeatures = await getReadyServerFeatures({
            timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 500,
            serverId: typeof params.serverId === 'string' ? params.serverId : undefined,
        });

        if (!serverFeatures) return true;

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
