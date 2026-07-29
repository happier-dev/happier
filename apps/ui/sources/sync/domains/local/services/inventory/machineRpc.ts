import {
    DaemonLocalServiceInventoryRefreshRequestV1Schema,
    DaemonLocalServiceInventoryRefreshResponseV1Schema,
    DaemonLocalServiceInventorySnapshotRequestV1Schema,
    DaemonLocalServiceInventorySnapshotResponseV1Schema,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    type LocalServiceInventorySnapshotClientInput,
    type LocalServiceInventorySnapshotClientResult,
} from './api';

export async function fetchLocalServiceInventorySnapshotViaMachineRpc(
    input: LocalServiceInventorySnapshotClientInput,
): Promise<LocalServiceInventorySnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const request = { machineId: input.machineId };
        const payload = input.refresh
            ? DaemonLocalServiceInventoryRefreshRequestV1Schema.parse(request)
            : DaemonLocalServiceInventorySnapshotRequestV1Schema.parse(request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: input.refresh
                ? RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
                : RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = input.refresh
            ? DaemonLocalServiceInventoryRefreshResponseV1Schema.safeParse(raw)
            : DaemonLocalServiceInventorySnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data.snapshot };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
