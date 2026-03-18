import type { FeaturesResponse } from '@happier-dev/protocol';

import {
    resolveAppSessionTransferRoute,
    type AppSessionTransferRoute,
    type AppSessionTransferUnavailableReasonCode,
} from './resolveAppSessionTransferRoute.js';

export const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';
export const SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR = 'File exceeds the server-routed transfer size limit';

export type AppSessionTransferAvailabilityResult =
    | Readonly<{
        kind: 'selected';
        route: AppSessionTransferRoute;
    }>
    | Readonly<{
        kind: 'unavailable';
        reasonCode: AppSessionTransferUnavailableReasonCode;
        errorMessage: string;
    }>;

export function resolveAppSessionTransferAvailability(input: Readonly<{
    machineTargetAvailable: boolean;
    sessionRpcAvailable: boolean;
    serverFeatures?: FeaturesResponse | null;
    sessionRpcTransferSizeBytes?: number | null;
}>): AppSessionTransferAvailabilityResult {
    const route = resolveAppSessionTransferRoute(input);
    if (route.kind === 'selected') {
        return route;
    }

    if (route.reasonCode === 'inactive_session_rpc_unavailable') {
        return {
            kind: 'unavailable',
            reasonCode: route.reasonCode,
            errorMessage: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        };
    }

    return {
        kind: 'unavailable',
        reasonCode: route.reasonCode,
        errorMessage: SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
    };
}
