import type { FeaturesResponse as ServerFeatures, SessionHandoffTransportStrategy } from '@happier-dev/protocol';
import { readServerEnabledBit } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR } from '@/sync/runtime/sessionMachineRpcFallback';
import {
    resolveMachineTransferRoute,
    resolveAppSessionTransferAvailability,
    SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
} from '@happier-dev/transfers';
export { INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR } from '@/sync/runtime/sessionMachineRpcFallback';
export const SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR = SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR;

type TransferRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;

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

export function resolveSessionRelayTransferAvailability(input: Readonly<{
    serverId?: string | null;
    sessionRpcAvailable: boolean;
    sessionRpcTransferSizeBytes?: number | null;
    serverFeatures?: ServerFeatures | null;
}>): SessionRelayTransferAvailability {
    const route = resolveAppSessionTransferAvailability({
        machineTargetAvailable: false,
        sessionRpcAvailable: input.sessionRpcAvailable,
        serverFeatures: input.serverFeatures,
        sessionRpcTransferSizeBytes: input.sessionRpcTransferSizeBytes,
    });
    if (route.kind === 'unavailable' && route.reasonCode === 'inactive_session_rpc_unavailable') {
        return {
            kind: 'unavailable',
            response: {
                success: false,
                error: route.errorMessage,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        };
    }
    if (route.kind === 'unavailable' && route.reasonCode === 'server_routed_transfer_too_large') {
        return {
            kind: 'unavailable',
            response: {
                success: false,
                error: route.errorMessage,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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

export function resolveMachineTransferAvailability(input: Readonly<{
    serverFeatures: unknown;
    preferredTransportStrategies: readonly SessionHandoffTransportStrategy[];
}>): SessionHandoffTransportError | SessionHandoffTransportAvailability {
    const features = resolveServerFeaturesPayload(input.serverFeatures);
    const handoffEnabled = features ? readServerEnabledBit(features, 'sessions.handoff') === true : false;
    if (!handoffEnabled) {
        return {
            ok: false,
            errorCode: 'handoff_disabled',
            errorMessage: 'Session handoff is disabled on the selected server',
        };
    }

    const route = resolveMachineTransferRoute({
        serverFeatures: features,
        preferredStrategies: input.preferredTransportStrategies,
        directPeerAvailable: true,
    });

    if (route.kind === 'unavailable' && route.reasonCode === 'transfer_disabled') {
        return {
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        };
    }

    if (route.kind === 'unavailable') {
        return {
            ok: false,
            errorCode: 'server_routed_transfer_disabled',
            errorMessage: 'Direct peer transfer is required because server-routed transfer is disabled',
        };
    }

    return {
        ok: true,
        negotiatedTransportStrategy: route.strategy,
        allowServerRoutedFallback: route.allowServerRoutedFallback,
    };
}
