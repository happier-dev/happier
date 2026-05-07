import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveAppSessionTransferAvailability } from '@happier-dev/transfers';
import {
    canUseSessionRpc,
    readMachineTargetForSession,
    resolveMachinePathFromSessionBase,
    shouldFallbackToSessionRpc,
} from '@/sync/ops/sessionMachineTarget';

export const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';

export type SessionMachineRpcTarget = Readonly<{
    machineId: string;
    basePath: string;
}>;

export type SessionMachineRpcFailure = Readonly<{
    success: false;
    error: string;
    errorCode?: string;
}>;

const GUARDED_MACHINE_RPC_METHOD_PREFIXES = [
    'daemon.bulkTransfer.',
] as const;

const GUARDED_MACHINE_RPC_METHODS = new Set<string>([
    RPC_METHODS.CREATE_DIRECTORY,
    RPC_METHODS.LIST_DIRECTORY,
    RPC_METHODS.GET_DIRECTORY_TREE,
    RPC_METHODS.STAT_FILE,
    RPC_METHODS.RENAME_PATH,
    RPC_METHODS.DELETE_PATH,
    RPC_METHODS.WRITE_FILE,
]);

type SessionMachineRpcMachineRoute = Readonly<{
    kind: 'machine_rpc_direct';
    machineTarget: SessionMachineRpcTarget;
}>;

type SessionMachineRpcSessionRoute = Readonly<{
    kind: 'server_routed_stream';
    serverId: string | undefined;
}>;

type SessionMachineRpcRouteSelection =
    | SessionMachineRpcMachineRoute
    | SessionMachineRpcSessionRoute;

type SessionMachineRpcFallbackResolution<TFailure> =
    | Readonly<{
        kind: 'selected';
        route: SessionMachineRpcSessionRoute;
    }>
    | Readonly<{
        kind: 'unavailable';
        response: TFailure;
    }>;

type SessionMachineRpcCallParams<TRequest> = Readonly<{
    request: TRequest;
    machineMethod: string;
    sessionMethod: string;
    toMachineRequest?: ((input: Readonly<{
        request: TRequest;
        machineTarget: SessionMachineRpcTarget;
    }>) => TRequest) | null;
    timeoutMs?: number;
}>;

type SessionMachineRpcSessionRouteCaller = <
    TResponse extends Readonly<{ success: boolean }>,
    TRequest,
>(input: Readonly<{
    sessionId: string;
    route: SessionMachineRpcSessionRoute;
    callParams: SessionMachineRpcCallParams<TRequest>;
}>) => Promise<TResponse>;

type SessionMachineRpcCaller<TFailure extends SessionMachineRpcFailure> = Readonly<{
    call: <TResponse extends Readonly<{ success: boolean }>, TRequest>(
        params: SessionMachineRpcCallParams<TRequest>,
    ) => Promise<TResponse>;
}>;

function shouldGuardMachineRpcDirectWithTransferPolicy(machineMethod: string): boolean {
    if (GUARDED_MACHINE_RPC_METHODS.has(machineMethod)) return true;
    return GUARDED_MACHINE_RPC_METHOD_PREFIXES.some((prefix) => machineMethod.startsWith(prefix));
}

async function resolveTransferPolicyAllowsMachineRpcDirect(sessionId: string): Promise<boolean> {
    try {
        const serverId = resolvePreferredServerIdForSessionId(sessionId);
        const serverFeatures = await getReadyServerFeatures({
            timeoutMs: 500,
            serverId,
        });

        // Fail closed for guarded methods: if we cannot evaluate policy, we must not attempt
        // `machine_rpc_direct` and risk bypassing server transfer restrictions.
        if (!serverFeatures) return false;

        const availability = resolveAppSessionTransferAvailability({
            machineTargetAvailable: true,
            sessionRpcAvailable: canUseSessionRpc(sessionId),
            serverFeatures,
            // Only enforce "transfer disabled" gating here; size checks are owned by the bulk transfer pipeline.
            sessionRpcTransferSizeBytes: null,
        });

        return availability.kind === 'selected' && availability.route === 'machine_rpc_direct';
    } catch {
        // If server feature evaluation fails, do not attempt `machine_rpc_direct`.
        return false;
    }
}

function readSessionMachineRpcErrorMessage(error: unknown): string {
    if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
        return error.message;
    }
    if (
        typeof error === 'object'
        && error !== null
        && 'message' in error
        && typeof (error as { message?: unknown }).message === 'string'
        && (error as { message: string }).message.length > 0
    ) {
        return (error as { message: string }).message;
    }
    return 'Unknown error';
}

function readInactiveSessionMachineFallbackRoute<TFailure extends SessionMachineRpcFailure>(input: Readonly<{
    sessionId: string;
    machineTarget: SessionMachineRpcTarget;
    fallbackRoute: SessionMachineRpcFallbackResolution<TFailure>;
    machineMethod: string;
}>): SessionMachineRpcSessionRoute | null {
    if (!shouldGuardMachineRpcDirectWithTransferPolicy(input.machineMethod)) {
        return null;
    }
    if (input.fallbackRoute.kind !== 'unavailable') {
        return null;
    }
    if (input.fallbackRoute.response.error !== INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR) {
        return null;
    }

    return {
        kind: 'server_routed_stream',
        serverId: resolvePreferredServerIdForSessionId(input.sessionId),
    };
}

async function callMachineRoute<TResponse extends Readonly<{ success: boolean }>, TRequest>(
    route: SessionMachineRpcMachineRoute,
    callParams: SessionMachineRpcCallParams<TRequest>,
): Promise<TResponse> {
    const machineRequest = callParams.toMachineRequest
        ? callParams.toMachineRequest({ request: callParams.request, machineTarget: route.machineTarget })
        : callParams.request;
    const response = await apiSocket.machineRPC<TResponse, TRequest>(
        route.machineTarget.machineId,
        callParams.machineMethod,
        machineRequest,
        callParams.timeoutMs ? { timeoutMs: callParams.timeoutMs } : undefined,
    );
    return assertRpcResponseWithSuccess<TResponse>(response);
}

async function callDefaultSessionRoute<TResponse extends Readonly<{ success: boolean }>, TRequest>(
    sessionId: string,
    route: SessionMachineRpcSessionRoute,
    callParams: SessionMachineRpcCallParams<TRequest>,
): Promise<TResponse> {
    if (shouldGuardMachineRpcDirectWithTransferPolicy(callParams.machineMethod)) {
        const machineTarget = readMachineTargetForSession(sessionId);
        if (!machineTarget) {
            throw new Error('Machine target not available for session');
        }
        const machineRequest = callParams.toMachineRequest
            ? callParams.toMachineRequest({ request: callParams.request, machineTarget })
            : callParams.request;
        const response = await machineRpcWithServerScope<TResponse, TRequest>({
            machineId: machineTarget.machineId,
            serverId: route.serverId,
            method: callParams.machineMethod,
            payload: machineRequest,
            preferScoped: true,
            timeoutMs: callParams.timeoutMs,
        });
        return assertRpcResponseWithSuccess<TResponse>(response);
    }

    const response = await sessionRpcWithServerScope<TResponse, TRequest>({
        sessionId,
        serverId: route.serverId,
        method: callParams.sessionMethod,
        payload: callParams.request,
        timeoutMs: callParams.timeoutMs,
    });
    return assertRpcResponseWithSuccess<TResponse>(response);
}

export function resolveDefaultSessionRpcFallbackRoute<TFailure>(input: Readonly<{
    sessionId: string;
    inactiveResponse: TFailure;
}>): SessionMachineRpcFallbackResolution<TFailure> {
    if (!canUseSessionRpc(input.sessionId)) {
        return {
            kind: 'unavailable',
            response: input.inactiveResponse,
        };
    }

        return {
            kind: 'selected',
            route: {
                kind: 'server_routed_stream',
                serverId: resolvePreferredServerIdForSessionId(input.sessionId),
            },
        };
}

export function createSessionMachineRpcFallbackCaller<TFailure extends SessionMachineRpcFailure>(params: Readonly<{
    sessionId: string;
    resolveFallbackRoute: () => Promise<SessionMachineRpcFallbackResolution<TFailure>>;
    errorResponse?: ((error: unknown) => TFailure) | null;
    callSessionRoute?: SessionMachineRpcSessionRouteCaller | null;
    reuseResolvedRoute?: boolean;
    fallbackOnLockedDirectRouteFailure?: boolean;
    shouldAttemptDirectRoute?: ((machineTarget: SessionMachineRpcTarget) => boolean) | null;
    onDirectRouteViable?: ((machineTarget: SessionMachineRpcTarget) => void) | null;
    onDirectRouteUnavailable?: ((input: Readonly<{ machineTarget: SessionMachineRpcTarget; error: unknown }>) => void) | null;
}>): SessionMachineRpcCaller<TFailure> {
    let lockedRoute: SessionMachineRpcRouteSelection | null = null;

    const errorResponse = params.errorResponse ?? ((error: unknown) => ({
        success: false,
        error: readSessionMachineRpcErrorMessage(error),
        errorCode: readRpcErrorCode(error),
    } as TFailure));
    const sessionRouteCaller = params.callSessionRoute ?? (async <TResponse extends Readonly<{ success: boolean }>, TRequest>(
        input: Readonly<{
            sessionId: string;
            route: SessionMachineRpcSessionRoute;
            callParams: SessionMachineRpcCallParams<TRequest>;
        }>,
    ): Promise<TResponse> => await callDefaultSessionRoute<TResponse, TRequest>(input.sessionId, input.route, input.callParams));

    return {
        call: async <TResponse extends Readonly<{ success: boolean }>, TRequest>(
            callParams: SessionMachineRpcCallParams<TRequest>,
        ): Promise<TResponse> => {
            try {
                if (lockedRoute?.kind === 'machine_rpc_direct') {
                    const lockedMachineRoute = lockedRoute;
                    if (shouldGuardMachineRpcDirectWithTransferPolicy(callParams.machineMethod)) {
                        const allowed = await resolveTransferPolicyAllowsMachineRpcDirect(params.sessionId);
                        if (!allowed) {
                            lockedRoute = null;
                        }
                    }

                    if (lockedRoute?.kind === 'machine_rpc_direct') {
                        try {
                            const response = await callMachineRoute<TResponse, TRequest>(lockedMachineRoute, callParams);
                            params.onDirectRouteViable?.(lockedMachineRoute.machineTarget);
                            return response;
                        } catch (error) {
                            if (!shouldFallbackToSessionRpc(params.sessionId, error)) {
                                return errorResponse(error) as unknown as TResponse;
                            }
                            params.onDirectRouteUnavailable?.({
                                machineTarget: lockedMachineRoute.machineTarget,
                                error,
                            });
                            if (params.fallbackOnLockedDirectRouteFailure !== true) {
                                return errorResponse(error) as unknown as TResponse;
                            }
                            lockedRoute = null;
                        }
                    }
                }

                if (lockedRoute?.kind === 'server_routed_stream') {
                    return await sessionRouteCaller<TResponse, TRequest>({
                        sessionId: params.sessionId,
                        route: lockedRoute,
                        callParams,
                    });
                }

                const machineTarget = readMachineTargetForSession(params.sessionId);
                if (machineTarget && (params.shouldAttemptDirectRoute?.(machineTarget) ?? true)) {
                    if (shouldGuardMachineRpcDirectWithTransferPolicy(callParams.machineMethod)) {
                        const allowed = await resolveTransferPolicyAllowsMachineRpcDirect(params.sessionId);
                        if (!allowed) {
                            const fallbackRoute = await params.resolveFallbackRoute();
                            if (fallbackRoute.kind === 'unavailable') {
                                const inactiveMachineFallbackRoute = readInactiveSessionMachineFallbackRoute({
                                    sessionId: params.sessionId,
                                    machineTarget,
                                    fallbackRoute,
                                    machineMethod: callParams.machineMethod,
                                });
                                if (!inactiveMachineFallbackRoute) {
                                    return fallbackRoute.response as unknown as TResponse;
                                }

                                return await sessionRouteCaller<TResponse, TRequest>({
                                    sessionId: params.sessionId,
                                    route: inactiveMachineFallbackRoute,
                                    callParams,
                                });
                            }

                            if (params.reuseResolvedRoute === true) {
                                lockedRoute = fallbackRoute.route;
                            }
                            return await sessionRouteCaller<TResponse, TRequest>({
                                sessionId: params.sessionId,
                                route: fallbackRoute.route,
                                callParams,
                            });
                        }
                    }

                    try {
                        const response = await callMachineRoute<TResponse, TRequest>({
                            kind: 'machine_rpc_direct',
                            machineTarget,
                        }, callParams);
                        if (params.reuseResolvedRoute === true) {
                            lockedRoute = {
                                kind: 'machine_rpc_direct',
                                machineTarget,
                            };
                        }
                        params.onDirectRouteViable?.(machineTarget);
                        return response;
                    } catch (error) {
                        if (!shouldFallbackToSessionRpc(params.sessionId, error)) {
                            return errorResponse(error) as unknown as TResponse;
                        }
                        params.onDirectRouteUnavailable?.({ machineTarget, error });
                    }
                }

                const fallbackRoute = await params.resolveFallbackRoute();
                if (fallbackRoute.kind === 'unavailable') {
                    return fallbackRoute.response as unknown as TResponse;
                }

                if (params.reuseResolvedRoute === true) {
                    lockedRoute = fallbackRoute.route;
                }
                return await sessionRouteCaller<TResponse, TRequest>({
                    sessionId: params.sessionId,
                    route: fallbackRoute.route,
                    callParams,
                });
            } catch (error) {
                return errorResponse(error) as unknown as TResponse;
            }
        },
    };
}

export async function callSessionMachineRpcWithFallback<
    TResponse extends Readonly<{ success: boolean }>,
    TRequest,
    TFailure extends SessionMachineRpcFailure,
>(params: Readonly<{
    sessionId: string;
    request: TRequest;
    machineMethod: string;
    sessionMethod: string;
    resolveFallbackRoute: () => Promise<SessionMachineRpcFallbackResolution<TFailure>>;
    errorResponse?: ((error: unknown) => TFailure) | null;
    toMachineRequest?: ((input: Readonly<{
        request: TRequest;
        machineTarget: SessionMachineRpcTarget;
    }>) => TRequest) | null;
    timeoutMs?: number;
}>): Promise<TResponse> {
    const caller = createSessionMachineRpcFallbackCaller<TFailure>({
        sessionId: params.sessionId,
        resolveFallbackRoute: params.resolveFallbackRoute,
        errorResponse: params.errorResponse,
    });
    return await caller.call<TResponse, TRequest>({
        request: params.request,
        machineMethod: params.machineMethod,
        sessionMethod: params.sessionMethod,
        toMachineRequest: params.toMachineRequest,
        timeoutMs: params.timeoutMs,
    });
}

export function rebasePathRequestToMachineTarget<TRequest extends Readonly<{ path: string }>>(input: Readonly<{
    request: TRequest;
    machineTarget: SessionMachineRpcTarget;
}>): TRequest {
    return {
        ...input.request,
        path: resolveMachinePathFromSessionBase({ basePath: input.machineTarget.basePath, requestPath: input.request.path }),
    };
}

export function rebaseTransferRequestPathToMachineTarget<TRequest extends Readonly<{ path: string }>>(input: Readonly<{
    request: TRequest;
    machineTarget: SessionMachineRpcTarget;
}>): TRequest {
    return rebasePathRequestToMachineTarget(input);
}

export function rebaseFromToRequestToMachineTarget<TRequest extends Readonly<{ from: string; to: string }>>(input: Readonly<{
    request: TRequest;
    machineTarget: SessionMachineRpcTarget;
}>): TRequest {
    return {
        ...input.request,
        from: resolveMachinePathFromSessionBase({ basePath: input.machineTarget.basePath, requestPath: input.request.from }),
        to: resolveMachinePathFromSessionBase({ basePath: input.machineTarget.basePath, requestPath: input.request.to }),
    };
}
