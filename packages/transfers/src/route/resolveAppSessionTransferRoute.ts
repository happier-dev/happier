import { readServerEnabledBit, type FeaturesResponse } from '@happier-dev/protocol';

import {
    isServerRoutedTransferOverSizeLimit,
    resolveServerRoutedTransferMaxBytesFromFeatures,
} from '../policy/serverRoutedTransferPolicy.js';

export type AppSessionTransferRoute = 'direct_peer' | 'server_routed_stream';

export type AppSessionTransferUnavailableReasonCode =
    | 'inactive_session_rpc_unavailable'
    | 'server_routed_transfer_too_large';

export type AppSessionTransferRouteResult =
    | Readonly<{
        kind: 'selected';
        route: AppSessionTransferRoute;
    }>
    | Readonly<{
        kind: 'unavailable';
        reasonCode: AppSessionTransferUnavailableReasonCode;
    }>;

type ResolveAppSessionTransferRouteInput = Readonly<{
    machineTargetAvailable: boolean;
    sessionRpcAvailable: boolean;
    serverFeatures?: FeaturesResponse | null;
    sessionRpcTransferSizeBytes?: number | null;
}>;

export function resolveAppSessionTransferRoute(
    input: ResolveAppSessionTransferRouteInput,
): AppSessionTransferRouteResult {
    if (input.machineTargetAvailable) {
        return {
            kind: 'selected',
            route: 'direct_peer',
        };
    }

    if (!input.sessionRpcAvailable) {
        return {
            kind: 'unavailable',
            reasonCode: 'inactive_session_rpc_unavailable',
        };
    }

    const serverRoutedEnabled = input.serverFeatures
        ? readServerEnabledBit(input.serverFeatures, 'machines.transfer.serverRouted') === true
        : false;
    if (!serverRoutedEnabled) {
        return {
            kind: 'selected',
            route: 'server_routed_stream',
        };
    }

    const maxBytes = resolveServerRoutedTransferMaxBytesFromFeatures(input.serverFeatures);
    if (
        typeof input.sessionRpcTransferSizeBytes === 'number'
        && isServerRoutedTransferOverSizeLimit(input.sessionRpcTransferSizeBytes, maxBytes)
    ) {
        return {
            kind: 'unavailable',
            reasonCode: 'server_routed_transfer_too_large',
        };
    }

    return {
        kind: 'selected',
        route: 'server_routed_stream',
    };
}
