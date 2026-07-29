import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    DaemonLocalServicePreviewOpenOrCreateRequestV1Schema,
    DaemonLocalServicePreviewOpenOrCreateResponseV1Schema,
    DaemonLocalServicePreviewRevokeRequestV1Schema,
    DaemonLocalServicePreviewRevokeResponseV1Schema,
    DaemonLocalServicePreviewSnapshotRequestV1Schema,
    DaemonLocalServicePreviewSnapshotResponseV1Schema,
    type DaemonLocalServicePreviewOpenOrCreateResponseV1,
    type DaemonLocalServicePreviewRevokeResponseV1,
    type DaemonLocalServicePreviewSnapshotResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';

// The snapshot RPC reads the preview registry; the lifecycle methods (openOrCreate/revoke)
// dispatch through the same daemon `LocalServicePreviewRoutes` owner so the UI runtime-action
// executor has a real cross-boundary transport (PRV-2, F2-preview), mirroring how the
// public-preview create/revoke handlers expose their owner over machine RPC.
export type DaemonLocalServicePreviewSnapshotHandlerOptions = Readonly<{
    localServicesPreview?:
        | (Pick<LocalServicePreviewRoutes, 'getSnapshot'>
            & Partial<Pick<LocalServicePreviewRoutes, 'openOrCreate' | 'revoke'>>)
        | null;
}>;

// A daemon lifecycle route refused the request (e.g. wrong machine, unknown inventory entry).
// Surface the reason on the wire so the UI maps it to a stable `preview_<reason>` disabled code
// instead of a generic transport failure.
class DaemonLocalServicePreviewLifecycleError extends Error {
    constructor(public readonly reasonCode: string) {
        super(`local_service_preview_lifecycle_refused:${reasonCode}`);
        this.name = 'DaemonLocalServicePreviewLifecycleError';
    }
}

export function isDaemonLocalServicePreviewLifecycleError(
    value: unknown,
): value is DaemonLocalServicePreviewLifecycleError {
    return value instanceof DaemonLocalServicePreviewLifecycleError;
}

export function registerDaemonLocalServicePreviewSnapshotHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonLocalServicePreviewSnapshotHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
        async (raw: unknown): Promise<DaemonLocalServicePreviewSnapshotResponseV1> => {
            DaemonLocalServicePreviewSnapshotRequestV1Schema.parse(raw);
            if (!options.localServicesPreview) {
                throw new Error('Local service preview runtime is unavailable');
            }
            return DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({
                protocolVersion: 1,
                snapshot: await options.localServicesPreview.getSnapshot(),
            });
        },
    );

    const routes = options.localServicesPreview;
    if (routes?.openOrCreate) {
        const openOrCreate = routes.openOrCreate;
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE,
            async (raw: unknown): Promise<DaemonLocalServicePreviewOpenOrCreateResponseV1> => {
                const request = DaemonLocalServicePreviewOpenOrCreateRequestV1Schema.parse(raw);
                const result = await openOrCreate(request);
                if (!result.ok) {
                    throw new DaemonLocalServicePreviewLifecycleError(result.reasonCode);
                }
                return DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(result.response);
            },
        );
    }

    if (routes?.revoke) {
        const revoke = routes.revoke;
        rpc.registerHandler(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE,
            async (raw: unknown): Promise<DaemonLocalServicePreviewRevokeResponseV1> => {
                const request = DaemonLocalServicePreviewRevokeRequestV1Schema.parse(raw);
                const result = await revoke(request);
                if (!result.ok) {
                    throw new DaemonLocalServicePreviewLifecycleError(result.reasonCode);
                }
                return DaemonLocalServicePreviewRevokeResponseV1Schema.parse(result.response);
            },
        );
    }
}
