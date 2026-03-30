import type { FeaturesResponse as ServerFeatures, SessionHandoffTransportStrategy } from '@happier-dev/protocol';
import { readServerEnabledBit } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR } from '@/sync/runtime/sessionMachineRpcFallback';
import {
    resolveAppSessionTransferAvailability,
    SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR as TRANSFERS_SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR,
    SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
} from '@happier-dev/transfers';
export { INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR } from '@/sync/runtime/sessionMachineRpcFallback';

const SERVER_ROUTED_TRANSFER_DISABLED_ERROR = 'Server-routed transfer is disabled on the selected server';

export { SERVER_ROUTED_TRANSFER_DISABLED_ERROR };
export const SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR = TRANSFERS_SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR;
export const SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR = SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR;

type TransferRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;

type SessionFileTransferRouteSelection =
    | Readonly<{
        kind: 'machine_rpc_direct';
    }>
    | Readonly<{
        kind: 'server_routed_stream';
        serverId: string | undefined;
    }>;

type SessionFileTransferRouteAvailability =
    | Readonly<{
        kind: 'selected';
        route: SessionFileTransferRouteSelection;
    }>
    | Readonly<{
        kind: 'unavailable';
        response: TransferRpcFailure;
    }>;

type SessionRelayTransferAvailability =
    | Readonly<{
        kind: 'selected';
        route: Readonly<{
            kind: 'server_routed_stream';
            serverId: string | undefined;
        }>;
    }>
    | Readonly<{
        kind: 'unavailable';
        response: TransferRpcFailure;
    }>;

type SessionHandoffTransportError = Readonly<{
    ok: false;
    errorCode: string;
    errorMessage: string;
}>;

type SessionHandoffTransportAvailability = Readonly<{
    ok: true;
    negotiatedTransportStrategy: SessionHandoffTransportStrategy;
    allowServerRoutedFallback: boolean;
}>;

function resolveServerFeaturesPayload(serverFeatures: unknown): ServerFeatures | null {
    const payload = (serverFeatures as { features?: unknown } | null)?.features;
    if (!payload || typeof payload !== 'object') return null;
    if (!('features' in payload) || !('capabilities' in payload)) return null;
    return payload as ServerFeatures;
}

function mapUnavailableSessionTransferAvailabilityToFailure(
    route: Readonly<{
        kind: 'unavailable';
        reasonCode: 'inactive_session_rpc_unavailable' | 'transfer_disabled' | 'transfer_policy_unavailable' | 'transfer_too_large';
        errorMessage: string;
    }>,
): TransferRpcFailure {
    if (route.reasonCode === 'inactive_session_rpc_unavailable' || route.reasonCode === 'transfer_too_large') {
        return {
            success: false,
            error: route.errorMessage,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    if (route.reasonCode === 'transfer_policy_unavailable') {
        return {
            success: false,
            error: SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    return {
        success: false,
        error: SERVER_ROUTED_TRANSFER_DISABLED_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };
}

export function resolveSessionFileTransferRouteAvailability(input: Readonly<{
    serverId?: string | null;
    machineTargetAvailable: boolean;
    sessionRpcAvailable: boolean;
    sessionRpcTransferSizeBytes?: number | null;
    serverFeatures?: ServerFeatures | null;
}>): SessionFileTransferRouteAvailability {
    if (!input.machineTargetAvailable && !input.sessionRpcAvailable) {
        return {
            kind: 'unavailable',
            response: {
                success: false,
                error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        };
    }

    const route = resolveAppSessionTransferAvailability({
        machineTargetAvailable: input.machineTargetAvailable,
        sessionRpcAvailable: input.sessionRpcAvailable,
        serverFeatures: input.serverFeatures,
        sessionRpcTransferSizeBytes: input.sessionRpcTransferSizeBytes,
    });
    if (route.kind === 'unavailable') {
        return {
            kind: 'unavailable',
            response: mapUnavailableSessionTransferAvailabilityToFailure(route),
        };
    }

    if (route.route === 'machine_rpc_direct') {
        return {
            kind: 'selected',
            route: {
                kind: 'machine_rpc_direct',
            },
        };
    }

    return {
        kind: 'selected',
        route: {
            kind: 'server_routed_stream',
            serverId: typeof input.serverId === 'string' ? input.serverId : undefined,
        },
    };
}

export function resolveSessionRelayTransferAvailability(input: Readonly<{
    serverId?: string | null;
    sessionRpcAvailable: boolean;
    sessionRpcTransferSizeBytes?: number | null;
    serverFeatures?: ServerFeatures | null;
}>): SessionRelayTransferAvailability {
    const route = resolveSessionFileTransferRouteAvailability({
        ...input,
        machineTargetAvailable: false,
    });
    if (route.kind === 'unavailable') {
        return route;
    }
    if (route.route.kind !== 'server_routed_stream') {
        return {
            kind: 'unavailable',
            response: {
                success: false,
                error: SERVER_ROUTED_TRANSFER_DISABLED_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        };
    }

    const serverRoute = route.route;

    return {
        kind: 'selected',
        route: {
            kind: 'server_routed_stream',
            serverId: serverRoute.serverId,
        },
    };
}

export function resolveMachineTransferAvailability(input: Readonly<{
    serverFeatures: unknown;
    preferredTransportStrategies: readonly SessionHandoffTransportStrategy[];
}>): SessionHandoffTransportError | SessionHandoffTransportAvailability {
    const features = resolveServerFeaturesPayload(input.serverFeatures);
    if (!features) {
        return {
            ok: false,
            errorCode: 'handoff_disabled',
            errorMessage: 'Session handoff is disabled on the selected server',
        };
    }

    const handoffEnabled = readServerEnabledBit(features, 'sessions.handoff') === true;
    if (!handoffEnabled) {
        return {
            ok: false,
            errorCode: 'handoff_disabled',
            errorMessage: 'Session handoff is disabled on the selected server',
        };
    }

    const transferEnabled = readServerEnabledBit(features, 'machines.transfer') === true;
    if (!transferEnabled) {
        return {
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        };
    }

    const directPeerEnabled = readServerEnabledBit(features, 'machines.transfer.directPeer') === true;
    const serverRoutedEnabled = readServerEnabledBit(features, 'machines.transfer.serverRouted') === true;
    if (!directPeerEnabled && !serverRoutedEnabled) {
        return {
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        };
    }

    for (const strategy of input.preferredTransportStrategies) {
        if (strategy === 'direct_peer' && directPeerEnabled) {
            return {
                ok: true,
                negotiatedTransportStrategy: 'direct_peer',
                allowServerRoutedFallback: serverRoutedEnabled,
            };
        }
        if (strategy === 'server_routed_stream' && serverRoutedEnabled) {
            return {
                ok: true,
                negotiatedTransportStrategy: 'server_routed_stream',
                allowServerRoutedFallback: true,
            };
        }
    }

    if (serverRoutedEnabled) {
        return {
            ok: true,
            negotiatedTransportStrategy: 'server_routed_stream',
            allowServerRoutedFallback: true,
        };
    }

    return {
        ok: true,
        negotiatedTransportStrategy: 'direct_peer',
        allowServerRoutedFallback: false,
    };
}
