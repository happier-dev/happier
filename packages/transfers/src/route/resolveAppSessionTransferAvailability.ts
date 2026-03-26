import type { FeaturesResponse } from '@happier-dev/protocol';

import {
    resolveAppSessionTransferRoute,
    type AppSessionTransferRoute,
    type AppSessionTransferUnavailableReasonCode,
} from './resolveAppSessionTransferRoute.js';

export const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';
export const SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR = 'Server transfer policy is unavailable on the selected server';
export const SERVER_ROUTED_TRANSFER_DISABLED_ERROR = 'Server-routed transfer is disabled on the selected server';
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

    if (route.reasonCode === 'transfer_disabled') {
        return {
            kind: 'unavailable',
            reasonCode: route.reasonCode,
            errorMessage: SERVER_ROUTED_TRANSFER_DISABLED_ERROR,
        };
    }

    if (route.reasonCode === 'transfer_policy_unavailable') {
        return {
            kind: 'unavailable',
            reasonCode: route.reasonCode,
            errorMessage: SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR,
        };
    }

    return {
        kind: 'unavailable',
        reasonCode: route.reasonCode,
        errorMessage: SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
    };
}
