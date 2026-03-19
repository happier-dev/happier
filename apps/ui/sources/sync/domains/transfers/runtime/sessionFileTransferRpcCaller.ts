import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { canUseSessionRpc } from '@/sync/ops/sessionMachineTarget';
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
    async function resolveSessionRoute(): Promise<
        | Readonly<{ kind: 'selected'; route: Readonly<{ kind: 'server_routed_stream'; serverId: string | undefined }> }>
        | Readonly<{ kind: 'unavailable'; response: TransferRpcFailure }>
    > {
        const serverId = resolvePreferredServerIdForSessionId(params.sessionId);
        const features = await getReadyServerFeatures({
            timeoutMs: 500,
            serverId,
        });
        return resolveSessionRelayTransferAvailability({
            serverId,
            sessionRpcAvailable: canUseSessionRpc(params.sessionId),
            sessionRpcTransferSizeBytes: params.sessionRpcTransferSizeBytes,
            serverFeatures: features,
        });
    }

    const caller = createSessionMachineRpcFallbackCaller<TransferRpcFailure>({
        sessionId: params.sessionId,
        resolveFallbackRoute: resolveSessionRoute,
        reuseResolvedRoute: true,
        fallbackOnLockedDirectRouteFailure: false,
        shouldAttemptDirectRoute: (machineTarget) => {
            const preferredServerId = resolvePreferredServerIdForSessionId(params.sessionId);
            const machineRouteCache = readCachedMachineRpcDirectRoute({
                serverId: preferredServerId,
                remoteMachineId: machineTarget.machineId,
            });
            return machineRouteCache.status !== 'unavailable';
        },
        onDirectRouteViable: (machineTarget) => {
            recordCachedMachineRpcDirectRouteViable({
                serverId: resolvePreferredServerIdForSessionId(params.sessionId),
                remoteMachineId: machineTarget.machineId,
            });
        },
        onDirectRouteUnavailable: ({ machineTarget, error }) => {
            recordCachedMachineRpcDirectRouteUnavailable(
                {
                    serverId: resolvePreferredServerIdForSessionId(params.sessionId),
                    remoteMachineId: machineTarget.machineId,
                },
                readRpcErrorCode(error) ?? 'machine_rpc_direct_unavailable',
            );
        },
    });

    return {
        call: async <TResponse extends TransferRpcSuccess | TransferRpcFailure, TRequest>(
            callParams: SessionFileTransferRpcCallParams<TRequest>,
        ): Promise<TResponse> => await caller.call<TResponse, TRequest>(callParams),
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
