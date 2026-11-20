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

/** The app reaches the shared simulator client through its captured-Account Machine RPC. */
export function createSimulatorPreviewRuntimeActionExecutor(
    input: CreateSimulatorPreviewRuntimeActionExecutorInput,
): RuntimeActionExecute {
    return createSimulatorPreviewRuntimeActionExecutorV1({
        ...input,
        fetchSnapshot: input.fetchSnapshot ?? fetchSimulatorPreviewSnapshotViaMachineRpc,
        dispatchAction: input.dispatchAction ?? dispatchSimulatorPreviewActionViaMachineRpc,
    });
}
