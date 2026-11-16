import type {
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
    SimulatorPreviewSnapshotV1,
    SimulatorDeviceOperationV1,
    SimulatorDeviceOperationResultV1,
    RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';

export type SimulatorPreviewRoutes = Readonly<{
    getSnapshot(): Promise<SimulatorPreviewSnapshotV1>;
    dispatchAction(event: SimulatorPreviewActionV1): Promise<SimulatorPreviewActionResultV1>;
    dispatchDeviceOperation?(input: SimulatorDeviceOperationV1,
        context: RuntimeActionExecuteArgs['context']): Promise<SimulatorDeviceOperationResultV1>;
}>;
