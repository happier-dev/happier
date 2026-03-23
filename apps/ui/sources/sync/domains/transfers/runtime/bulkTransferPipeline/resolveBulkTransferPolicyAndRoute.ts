import type { FeaturesResponse } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    resolveAppSessionTransferAvailability,
    SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
    type AppSessionTransferRoute,
} from '@happier-dev/transfers';

const SERVER_ROUTED_TRANSFER_DISABLED_ERROR = 'Server-routed transfer is disabled on the selected server';

type BulkTransferFailureResponse = Readonly<{
    success: false;
    error: string;
    errorCode?: string;
}>;

export type BulkTransferPolicyAndRouteResult =
    | Readonly<{
        kind: 'selected';
        route: Readonly<{
            kind: AppSessionTransferRoute;
            serverId: string | undefined;
        }>;
    }>
    | Readonly<{
        kind: 'unavailable';
        response: BulkTransferFailureResponse;
    }>;

function mapUnavailableReasonToMessage(reasonCode: 'inactive_session_rpc_unavailable' | 'transfer_disabled' | 'transfer_too_large'): string {
    if (reasonCode === 'inactive_session_rpc_unavailable') {
        return INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR;
    }
    if (reasonCode === 'transfer_disabled') {
        return SERVER_ROUTED_TRANSFER_DISABLED_ERROR;
    }
    return SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR;
}

export function resolveBulkTransferPolicyAndRoute(input: Readonly<{
    serverId?: string | null;
    machineTargetAvailable: boolean;
    sessionRpcAvailable: boolean;
    transferSizeBytes?: number | null;
    serverFeatures?: FeaturesResponse | null;
}>): BulkTransferPolicyAndRouteResult {
    const route = resolveAppSessionTransferAvailability({
        machineTargetAvailable: input.machineTargetAvailable,
        sessionRpcAvailable: input.sessionRpcAvailable,
        sessionRpcTransferSizeBytes: input.transferSizeBytes,
        serverFeatures: input.serverFeatures,
    });

    if (route.kind === 'unavailable') {
        return {
            kind: 'unavailable',
            response: {
                success: false,
                error: mapUnavailableReasonToMessage(route.reasonCode),
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        };
    }

    return {
        kind: 'selected',
        route: {
            kind: route.route,
            serverId: typeof input.serverId === 'string' ? input.serverId : undefined,
        },
    };
}
