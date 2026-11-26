import { createActionExecuteFailureError, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    dispatchSimulatorPreviewActionV1,
    fetchSimulatorPreviewSnapshotV1,
    type SimulatorMachineRpcCallV1,
    type SimulatorPreviewActionClientInput,
    type SimulatorPreviewActionClientResult as ProtocolPreviewActionResult,
    type SimulatorPreviewSnapshotClientInput,
    type SimulatorPreviewSnapshotClientResult as ProtocolPreviewSnapshotResult,
} from '@happier-dev/protocol/devices/simulator/runtimeActionClient';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { projectMachineActionRpcFailure } from '@/sync/domains/machines/machineDaemonRpcErrors';

export type { SimulatorPreviewActionClientInput, SimulatorPreviewSnapshotClientInput };

type SimulatorPreviewRouteFailure = Readonly<{ ok: false; reason: 'request_failed' }> & Partial<ActionExecuteFailure>;
export type SimulatorPreviewSnapshotClientResult = ProtocolPreviewSnapshotResult | SimulatorPreviewRouteFailure;
export type SimulatorPreviewActionClientResult = ProtocolPreviewActionResult | SimulatorPreviewRouteFailure;

const callMachineRpc: SimulatorMachineRpcCallV1 = async ({ machineId, serverId, method, payload, signal }) => {
    const raw = await machineRpcWithServerScope<unknown, unknown>({ machineId, serverId, method, payload, signal });
    const refusal = projectMachineActionRpcFailure(raw);
    if (refusal) throw createActionExecuteFailureError(refusal);
    return raw;
};

function projectTransportFailure(error: unknown): SimulatorPreviewRouteFailure {
    return { ok: false, ...projectMachineActionRpcFailure(error), reason: 'request_failed' };
}

export async function fetchSimulatorPreviewSnapshotViaMachineRpc(
    input: SimulatorPreviewSnapshotClientInput,
): Promise<SimulatorPreviewSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        return await fetchSimulatorPreviewSnapshotV1(callMachineRpc, input);
    } catch (error) {
        return projectTransportFailure(error);
    }
}

export async function dispatchSimulatorPreviewActionViaMachineRpc(
    input: SimulatorPreviewActionClientInput,
): Promise<SimulatorPreviewActionClientResult> {
    try {
        return await dispatchSimulatorPreviewActionV1(callMachineRpc, input);
    } catch (error) {
        return projectTransportFailure(error);
    }
}
