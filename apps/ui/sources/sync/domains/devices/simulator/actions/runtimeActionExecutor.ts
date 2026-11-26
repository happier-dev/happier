import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import {
    createSimulatorPreviewRuntimeActionExecutorV1,
    type CreateSimulatorPreviewRuntimeActionExecutorV1Input,
} from '@happier-dev/protocol/devices/simulator/runtimeActionClient';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';

import {
    dispatchSimulatorPreviewActionViaMachineRpc,
    fetchSimulatorPreviewSnapshotViaMachineRpc,
} from '../machineRpc';

type CreateSimulatorPreviewRuntimeActionExecutorInput = Omit<CreateSimulatorPreviewRuntimeActionExecutorV1Input, 'fetchSnapshot' | 'dispatchAction'>
    & Partial<Pick<CreateSimulatorPreviewRuntimeActionExecutorV1Input, 'fetchSnapshot' | 'dispatchAction'>>;

function carrySimulatorTransportRefusal<T>(result: T): T {
    const refusal = readActionFailureEnvelope(result);
    if (refusal) throw createActionExecuteFailureError(refusal);
    return result;
}

/** The app reaches the shared simulator client through its captured-Account Machine RPC. */
export function createSimulatorPreviewRuntimeActionExecutor(
    input: CreateSimulatorPreviewRuntimeActionExecutorInput,
): RuntimeActionExecute {
    return createSimulatorPreviewRuntimeActionExecutorV1({
        ...input,
        fetchSnapshot: input.fetchSnapshot ?? (request => fetchSimulatorPreviewSnapshotViaMachineRpc(request).then(carrySimulatorTransportRefusal)),
        dispatchAction: input.dispatchAction ?? (request => dispatchSimulatorPreviewActionViaMachineRpc(request).then(carrySimulatorTransportRefusal)),
    });
}
