import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
    parseDaemonContributionRegistryProjectionDescribeResponse,
    type DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';

export type MachineContributionRegistryProjectionDescribeResult =
    | Readonly<{ supported: true; projection: DaemonContributionRegistryProjection }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

export async function machineContributionRegistryProjectionDescribe(
    machineId: string,
    opts?: Readonly<{ serverId?: string | null; timeoutMs?: number | null }>,
): Promise<MachineContributionRegistryProjectionDescribeResult> {
    try {
        const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts?.serverId,
            timeoutMs: typeof opts?.timeoutMs === 'number' ? opts?.timeoutMs : undefined,
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported' };
        }
        const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(response);
        if (!parsed) {
            return { supported: false, reason: 'error' };
        }
        return { supported: true, projection: parsed };
    } catch {
        return { supported: false, reason: 'error' };
    }
}
