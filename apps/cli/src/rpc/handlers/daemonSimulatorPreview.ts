import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    DaemonSimulatorPreviewActionRequestV1Schema,
    DaemonSimulatorPreviewActionResponseV1Schema,
    DaemonSimulatorPreviewSnapshotRequestV1Schema,
    DaemonSimulatorPreviewSnapshotResponseV1Schema,
    type DaemonSimulatorPreviewActionResponseV1,
    type DaemonSimulatorPreviewSnapshotResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';

export type DaemonSimulatorPreviewHandlerOptions = Readonly<{
    simulatorPreview?: SimulatorPreviewRoutes | null;
}>;

export function registerDaemonSimulatorPreviewHandlers(
    rpc: RpcHandlerRegistrar,
    options: DaemonSimulatorPreviewHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_SNAPSHOT,
        async (raw: unknown): Promise<DaemonSimulatorPreviewSnapshotResponseV1> => {
            DaemonSimulatorPreviewSnapshotRequestV1Schema.parse(raw);
            if (!options.simulatorPreview) {
                throw new Error('Simulator preview runtime is unavailable');
            }
            return DaemonSimulatorPreviewSnapshotResponseV1Schema.parse({
                protocolVersion: 1,
                snapshot: await options.simulatorPreview.getSnapshot(),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_SIMULATOR_PREVIEW_ACTION,
        async (raw: unknown): Promise<DaemonSimulatorPreviewActionResponseV1> => {
            const request = DaemonSimulatorPreviewActionRequestV1Schema.parse(raw);
            if (!options.simulatorPreview) {
                throw new Error('Simulator preview runtime is unavailable');
            }
            return DaemonSimulatorPreviewActionResponseV1Schema.parse({
                protocolVersion: 1,
                result: await options.simulatorPreview.dispatchAction(request.event),
            });
        },
    );
}
