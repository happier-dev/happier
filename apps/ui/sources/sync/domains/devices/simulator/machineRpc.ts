import {
    DaemonSimulatorPreviewActionRequestV1Schema,
    DaemonSimulatorPreviewActionResponseV1Schema,
    DaemonSimulatorPreviewSnapshotRequestV1Schema,
    DaemonSimulatorPreviewSnapshotResponseV1Schema,
    type SimulatorPreviewActionResultV1,
    type SimulatorPreviewActionV1,
    type SimulatorPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type SimulatorPreviewSnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type SimulatorPreviewSnapshotClientResult =
    | Readonly<{ ok: true; snapshot: SimulatorPreviewSnapshotV1 }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

export type SimulatorPreviewActionClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    event: SimulatorPreviewActionV1;
}>;

export type SimulatorPreviewActionClientResult =
    | Readonly<{ ok: true; result: SimulatorPreviewActionResultV1 }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

function snapshotMatchesMachine(
    snapshot: SimulatorPreviewSnapshotV1,
    machineId: string,
): boolean {
    return snapshot.machineId === machineId
        && snapshot.resources.every((resource) => resource.simulatorId.trim().length > 0);
}

export async function fetchSimulatorPreviewSnapshotViaMachineRpc(
    input: SimulatorPreviewSnapshotClientInput,
): Promise<SimulatorPreviewSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonSimulatorPreviewSnapshotRequestV1Schema.parse({
            machineId: input.machineId,
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonSimulatorPreviewSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || !snapshotMatchesMachine(parsed.data.snapshot, input.machineId)) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data.snapshot };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

export async function dispatchSimulatorPreviewActionViaMachineRpc(
    input: SimulatorPreviewActionClientInput,
): Promise<SimulatorPreviewActionClientResult> {
    try {
        const payload = DaemonSimulatorPreviewActionRequestV1Schema.parse({
            protocolVersion: 1,
            machineId: input.machineId,
            event: input.event,
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonSimulatorPreviewActionResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, result: parsed.data.result }
            : { ok: false, reason: 'invalid_response' };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
