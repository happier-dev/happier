import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { canUseSessionRpc, readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import {
    readCachedMachineRpcDirectRoute,
    recordCachedMachineRpcDirectRouteUnavailable,
    recordCachedMachineRpcDirectRouteViable,
} from '@/sync/domains/transfers/runtime/transferRouteCache';
import {
    createSessionMachineRpcFallbackCaller,
    type SessionMachineRpcFailure,
    type SessionMachineRpcTarget as SessionFileTransferMachineTarget,
} from '@/sync/runtime/sessionMachineRpcFallback';
import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    resolveSessionFileTransferRouteAvailability,
    resolveSessionRelayTransferAvailability,
    SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
} from '@/sync/domains/transfers/runtime/resolveTransferAvailability';

export {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
} from '@/sync/domains/transfers/runtime/resolveTransferAvailability';

type TransferRpcSuccess = Readonly<{ success: true }>;
type TransferRpcFailure = SessionMachineRpcFailure;

type SessionFileTransferRpcCallParams<TRequest> = Readonly<{
    request: TRequest;
    machineMethod: string;
    sessionMethod: string;
    toMachineRequest?: ((input: Readonly<{
        request: TRequest;
        machineTarget: SessionFileTransferMachineTarget;
    }>) => TRequest) | null;
}>;

export type SessionFileTransferRpcCaller = Readonly<{
    call: <TResponse extends TransferRpcSuccess | TransferRpcFailure, TRequest>(
        params: SessionFileTransferRpcCallParams<TRequest>,
    ) => Promise<TResponse>;
}>;

export function createSessionFileTransferRpcCaller(params: Readonly<{
    sessionId: string;
    sessionRpcTransferSizeBytes?: number | null;
}>): SessionFileTransferRpcCaller {
    function resolveSessionRouteFromSharedPolicy(input: Readonly<{
        serverId: string | undefined;
        sessionRpcAvailable: boolean;
        serverFeatures: Awaited<ReturnType<typeof getReadyServerFeatures>>;
    }>): ReturnType<typeof resolveSessionRelayTransferAvailability> {
        return resolveSessionRelayTransferAvailability({
            serverId: input.serverId,
            sessionRpcAvailable: input.sessionRpcAvailable,
            sessionRpcTransferSizeBytes: params.sessionRpcTransferSizeBytes,
            serverFeatures: input.serverFeatures,
        });
    }

    return {
        call: async <TResponse extends TransferRpcSuccess | TransferRpcFailure, TRequest>(
            callParams: SessionFileTransferRpcCallParams<TRequest>,
        ): Promise<TResponse> => {
            const machineTarget = readMachineTargetForSession(params.sessionId);
            const serverId = resolvePreferredServerIdForSessionId(params.sessionId);
            const serverFeatures = await getReadyServerFeatures({
                timeoutMs: 500,
                serverId,
            });
            const sessionRpcAvailable = canUseSessionRpc(params.sessionId);

            const preferredRoute = resolveSessionFileTransferRouteAvailability({
                serverId,
                machineTargetAvailable: machineTarget !== null,
                sessionRpcAvailable,
                sessionRpcTransferSizeBytes: params.sessionRpcTransferSizeBytes,
                serverFeatures,
            });

            const caller = createSessionMachineRpcFallbackCaller<TransferRpcFailure>({
                sessionId: params.sessionId,
                resolveFallbackRoute: async (): Promise<
        | Readonly<{ kind: 'selected'; route: Readonly<{ kind: 'server_routed_stream'; serverId: string | undefined }> }>
        | Readonly<{ kind: 'unavailable'; response: TransferRpcFailure }>
                > => {
                    if (preferredRoute.kind === 'selected' && preferredRoute.route.kind === 'server_routed_stream') {
                        const serverRoute = preferredRoute.route;
                        return {
                            kind: 'selected',
                            route: serverRoute,
                        };
                    }
                    if (preferredRoute.kind === 'unavailable') {
                        return preferredRoute;
                    }

                    return resolveSessionRouteFromSharedPolicy({
                        serverId,
                        sessionRpcAvailable,
                        serverFeatures,
                    });
                },
                reuseResolvedRoute: true,
                fallbackOnLockedDirectRouteFailure: false,
                shouldAttemptDirectRoute: (target) => {
                    if (preferredRoute.kind !== 'selected' || preferredRoute.route.kind !== 'machine_rpc_direct') {
                        return false;
                    }
                    if (!machineTarget || machineTarget.machineId !== target.machineId) {
                        return false;
                    }

                    const machineRouteCache = readCachedMachineRpcDirectRoute({
                        serverId,
                        remoteMachineId: target.machineId,
                    });
                    return machineRouteCache.status !== 'unavailable';
                },
                onDirectRouteViable: (target) => {
                    recordCachedMachineRpcDirectRouteViable({
                        serverId,
                        remoteMachineId: target.machineId,
                    });
                },
                onDirectRouteUnavailable: ({ machineTarget: target, error }) => {
                    recordCachedMachineRpcDirectRouteUnavailable(
                        {
                            serverId,
                            remoteMachineId: target.machineId,
                        },
                        readRpcErrorCode(error) ?? 'machine_rpc_direct_unavailable',
                    );
                },
            });

            const response = await caller.call<TResponse, TRequest>(callParams);

            // If the session is inactive, callers cannot fall back to server-routed session RPC.
            // Ensure direct-route failures are recorded so feature availability can hide actions
            // after a failure instead of staying stuck at "unknown".
            if (
                machineTarget
                && sessionRpcAvailable === false
                && preferredRoute.kind === 'selected'
                && preferredRoute.route.kind === 'machine_rpc_direct'
                && (response as { success?: unknown } | null)?.success === false
            ) {
                const errorCode = (response as { errorCode?: unknown } | null)?.errorCode;
                recordCachedMachineRpcDirectRouteUnavailable(
                    {
                        serverId,
                        remoteMachineId: machineTarget.machineId,
                    },
                    typeof errorCode === 'string' && errorCode.trim().length > 0
                        ? errorCode
                        : 'machine_rpc_direct_unavailable',
                );
            }

            return response;
        },
    };
}

export async function callSessionFileTransferRpc<TResponse extends TransferRpcSuccess | TransferRpcFailure, TRequest>(params: Readonly<{
    sessionId: string;
    request: TRequest;
    machineMethod: string;
    sessionMethod: string;
    toMachineRequest?: ((input: Readonly<{
        request: TRequest;
        machineTarget: SessionFileTransferMachineTarget;
    }>) => TRequest) | null;
    sessionRpcTransferSizeBytes?: number | null;
}>): Promise<TResponse> {
    const caller = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
        sessionRpcTransferSizeBytes: params.sessionRpcTransferSizeBytes,
    });
    return await caller.call<TResponse, TRequest>({
        request: params.request,
        machineMethod: params.machineMethod,
        sessionMethod: params.sessionMethod,
        toMachineRequest: params.toMachineRequest,
    });
}
