import { readServerEnabledBit, type FeaturesResponse } from '@happier-dev/protocol';

import {
    isServerRoutedTransferOverSizeLimit,
    resolveServerRoutedTransferMaxBytesFromFeatures,
} from '../policy/serverRoutedTransferPolicy.js';

export type AppSessionTransferRoute = 'machine_rpc_direct' | 'server_routed_stream';

export type AppSessionTransferUnavailableReasonCode =
    | 'inactive_session_rpc_unavailable'
    | 'transfer_disabled'
    | 'transfer_policy_unavailable'
    | 'transfer_too_large';

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
    if (input.serverFeatures) {
        // Treat missing/malformed enabled bits as disabled (fail closed).
        const transferEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer') === true;
        if (!transferEnabled) {
            return {
                kind: 'unavailable',
                reasonCode: 'transfer_disabled',
            };
        }
    }

    const maxBytes = resolveServerRoutedTransferMaxBytesFromFeatures(input.serverFeatures);
    if (input.serverFeatures == null && typeof input.sessionRpcTransferSizeBytes === 'number') {
        return {
            kind: 'unavailable',
            reasonCode: 'transfer_policy_unavailable',
        };
    }
    if (
        typeof input.sessionRpcTransferSizeBytes === 'number'
        && isServerRoutedTransferOverSizeLimit(input.sessionRpcTransferSizeBytes, maxBytes)
    ) {
        return {
            kind: 'unavailable',
            reasonCode: 'transfer_too_large',
        };
    }

    if (input.machineTargetAvailable) {
        // Direct machine RPC must not be selected without a server feature snapshot; otherwise
        // callers can accidentally bypass the shared policy choke point when the snapshot is
        // missing/unavailable.
        if (input.serverFeatures) {
            return {
                kind: 'selected',
                route: 'machine_rpc_direct',
            };
        }
    }

    if (!input.sessionRpcAvailable) {
        return {
            kind: 'unavailable',
            reasonCode: 'inactive_session_rpc_unavailable',
        };
    }

    if (input.serverFeatures) {
        // Treat missing/malformed enabled bits as disabled (fail closed).
        const serverRoutedEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer.serverRouted') === true;
        if (!serverRoutedEnabled) {
            return {
                kind: 'unavailable',
                reasonCode: 'transfer_disabled',
            };
        }
    }

    return {
        kind: 'selected',
        route: 'server_routed_stream',
    };
}
