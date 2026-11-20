import {
    dispatchSimulatorPreviewActionV1,
    fetchSimulatorPreviewSnapshotV1,
    type SimulatorMachineRpcCallV1,
    type SimulatorPreviewActionClientInput,
    type SimulatorPreviewActionClientResult,
    type SimulatorPreviewSnapshotClientInput,
    type SimulatorPreviewSnapshotClientResult,
} from '@happier-dev/protocol/devices/simulator/runtimeActionClient';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type {
    SimulatorPreviewActionClientInput,
    SimulatorPreviewActionClientResult,
    SimulatorPreviewSnapshotClientInput,
    SimulatorPreviewSnapshotClientResult,
};

const callMachineRpc: SimulatorMachineRpcCallV1 = ({ machineId, serverId, method, payload, signal }) =>
    machineRpcWithServerScope<unknown, unknown>({ machineId, serverId, method, payload, signal });

export async function fetchSimulatorPreviewSnapshotViaMachineRpc(
    input: SimulatorPreviewSnapshotClientInput,
): Promise<SimulatorPreviewSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        return await fetchSimulatorPreviewSnapshotV1(callMachineRpc, input);
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

export async function dispatchSimulatorPreviewActionViaMachineRpc(
    input: SimulatorPreviewActionClientInput,
): Promise<SimulatorPreviewActionClientResult> {
    try {
        return await dispatchSimulatorPreviewActionV1(callMachineRpc, input);
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
