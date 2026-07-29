import type {
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
    SimulatorPreviewSnapshotV1,
} from '@happier-dev/protocol';

export type SimulatorPreviewRoutes = Readonly<{
    getSnapshot(): Promise<SimulatorPreviewSnapshotV1>;
    dispatchAction(event: SimulatorPreviewActionV1): Promise<SimulatorPreviewActionResultV1>;
}>;
