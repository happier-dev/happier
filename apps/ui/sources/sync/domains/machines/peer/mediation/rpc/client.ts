import {
    PEER_MACHINE_RPC_DIRECT_PATH_V1,
    PEER_MACHINE_RPC_DIRECT_PATH_V2,
    PEER_MEDIATION_RECEIPTS,
    PeerMachineRpcDirectResponseV1Schema,
    PeerMachineRpcDirectResponseV2Schema,
    createPeerMachineRpcRequestHashV1,
    isMachineRpcDirectRoutePolicy,
    resolveMachineRpcRelayFallbackDecision,
    resolveMachineRpcRoutePolicy,
    type MachineRpcRelayFallbackDecision,
    type MachineRpcRoutePolicyV1,
    type PeerMachineRpcDirectRequestV1,
    type PeerMachineRpcDirectRequestV2,
    type PeerMachineRpcDirectResponseV1,
    type PeerMachineRpcDirectResponseV2,
    type PeerRouteEphemeralProofV2,
    type PeerRouteNonceProofV1,
    type SignedDirectRouteGrantV1,
    type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';

import { createMachineRpcPeerFallbackReceipt, type MachineRpcPeerFallbackReceipt } from './fallback';

export type MachineRpcDirectRouteResolution =
    | Readonly<{
        kind: 'selected';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeSelected;
        endpoint: Readonly<{
            url: string;
            endpointFingerprint: string;
        }>;
        grant: SignedDirectRouteGrantV1;
        nonceProof: PeerRouteNonceProofV1;
    }>
    | Readonly<{
        kind: 'selected';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeSelected;
        endpoint: Readonly<{
            url: string;
            endpointFingerprint: string;
        }>;
        grant: SignedDirectRouteGrantV2;
        proof: PeerRouteEphemeralProofV2;
    }>
    | Readonly<{
        kind: 'fallback';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
        reasonCode: string;
        requiredCapability?: string;
    }>;

export type MachineRpcWithPeerMediationRouteParams<A> = Readonly<{
    serverId?: string | null;
    machineId: string;
    method: string;
    payload: A;
    timeoutMs?: number;
    authorization?: SocketRpcAuthorizationContext;
    /**
     * Caller abort signal. Forwarded to the direct transport (`postDirect`) so a
     * cancelled RPC propagates uniformly on the direct peer route as well as the
     * server-fallback route. Prompt rejection on abort is owned by the injected
     * transports, mirroring `serverFallback`.
     */
    signal?: AbortSignal;
    resolveDirectRoute: (input: Readonly<{
        serverId?: string | null;
        machineId: string;
        method: string;
    }>) => Promise<MachineRpcDirectRouteResolution>;
    postDirect: (input: Readonly<{
        url: string;
        request: PeerMachineRpcDirectRequestV1 | PeerMachineRpcDirectRequestV2;
        timeoutMs?: number;
        signal?: AbortSignal;
    }>) => Promise<PeerMachineRpcDirectResponseV1 | PeerMachineRpcDirectResponseV2>;
    serverFallback: (input: Readonly<{
        serverId?: string | null;
        machineId: string;
        method: string;
        payload: A;
        timeoutMs?: number;
        authorization?: SocketRpcAuthorizationContext;
        reasonCode: string;
        requiredCapability?: string;
    }>) => Promise<unknown>;
    resolveRelayFallback?: (input: Readonly<{
        method: string;
        reasonCode: string;
        policy: Pick<MachineRpcRoutePolicyV1, 'relayFallback'>;
    }>) => MachineRpcRelayFallbackDecision | Promise<MachineRpcRelayFallbackDecision>;
    recordReceipt?: (receipt: Readonly<Record<string, unknown>>) => void;
    createRequestId?: () => string;
}>;

function createRequestId(): string {
    return `rpc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function resolveDirectRpcUrl(endpointUrl: string, version: 1 | 2): string {
    const parsed = new URL(endpointUrl);
    parsed.pathname = version === 2 ? PEER_MACHINE_RPC_DIRECT_PATH_V2 : PEER_MACHINE_RPC_DIRECT_PATH_V1;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
}

function createRelayFallbackDisabledError(params: Readonly<{
    method: string;
    reasonCode: string;
}>): Error {
    const error = new Error(`Machine RPC relay fallback is disabled for ${params.method}: ${params.reasonCode}`);
    Object.assign(error, {
        code: 'MACHINE_RPC_RELAY_FALLBACK_DISABLED',
        method: params.method,
        reasonCode: params.reasonCode,
    });
    return error;
}

async function useServerFallback<R, A>(
    params: MachineRpcWithPeerMediationRouteParams<A>,
    reasonCode: string,
    requestId?: string,
    receipt?: MachineRpcPeerFallbackReceipt,
    requiredCapability?: string,
): Promise<R> {
    const policy = resolveMachineRpcRoutePolicy(params.method);
    params.recordReceipt?.(receipt ?? createMachineRpcPeerFallbackReceipt({
        method: params.method,
        requestId,
        reasonCode,
    }));
    if (policy.relayFallback) {
        const decision = await (params.resolveRelayFallback?.({
            method: params.method,
            reasonCode,
            policy,
        }) ?? resolveMachineRpcRelayFallbackDecision({
            policy,
            deploymentKind: 'shared_server',
            relayEnabled: false,
        }));
        if (!decision.ok) {
            params.recordReceipt?.(createMachineRpcPeerFallbackReceipt({
                method: params.method,
                requestId,
                reasonCode: decision.reasonCode,
                receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
            }));
            throw createRelayFallbackDisabledError({
                method: params.method,
                reasonCode: decision.reasonCode,
            });
        }
    }
    return await params.serverFallback({
        serverId: params.serverId,
        machineId: params.machineId,
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        authorization: params.authorization,
        reasonCode,
        ...(requiredCapability ? { requiredCapability } : {}),
    }) as R;
}

export async function machineRpcWithPeerMediationRoute<R, A>(
    params: MachineRpcWithPeerMediationRouteParams<A>,
): Promise<R> {
    const policy = resolveMachineRpcRoutePolicy(params.method);
    if (!isMachineRpcDirectRoutePolicy(policy)) {
        return await useServerFallback<R, A>(
            params,
            policy.serverRequiredReason === 'unclassified' ? 'method_unclassified' : 'server_required',
        );
    }

    const requestId = params.createRequestId?.() ?? createRequestId();
    const route = await params.resolveDirectRoute({
        serverId: params.serverId,
        machineId: params.machineId,
        method: params.method,
    });
    if (route.kind === 'fallback') {
        return await useServerFallback<R, A>(
            params,
            route.reasonCode,
            requestId,
            createMachineRpcPeerFallbackReceipt({
                method: params.method,
                requestId,
                reasonCode: route.reasonCode,
                receipt: route.receipt,
            }),
            route.requiredCapability,
        );
    }

    params.recordReceipt?.({
        receipt: route.receipt,
        method: params.method,
        requestId,
        routeKind: 'loopback_direct',
        endpointFingerprint: route.endpoint.endpointFingerprint,
    });

    const replayKey = requestId;
    const requestHash = createPeerMachineRpcRequestHashV1({
        method: params.method,
        params: params.payload,
        grantId: route.grant.payload.grantId,
        endpointFingerprint: route.endpoint.endpointFingerprint,
        replayKey,
    });
    const directRequest: PeerMachineRpcDirectRequestV1 | PeerMachineRpcDirectRequestV2 = 'proof' in route
        ? {
            v: 2,
            requestId,
            method: params.method,
            params: params.payload,
            grant: route.grant,
            proof: route.proof,
            routeKind: 'loopback_direct',
            flowKind: 'machine_rpc',
            endpointFingerprint: route.endpoint.endpointFingerprint,
            ...(policy.commandReceiptRequired
                ? {
                    commandReceipt: {
                        v: 1 as const,
                        issuer: 'ui' as const,
                        issuedAtMs: Date.now(),
                        requestHash,
                        replayKey,
                    },
                }
                : {}),
        }
        : {
            v: 1,
            requestId,
            method: params.method,
            params: params.payload,
            grant: route.grant,
            nonceProof: route.nonceProof,
            routeKind: 'loopback_direct',
            flowKind: 'machine_rpc',
            endpointFingerprint: route.endpoint.endpointFingerprint,
            ...(policy.commandReceiptRequired
                ? {
                    commandReceipt: {
                        v: 1 as const,
                        issuer: 'ui' as const,
                        issuedAtMs: Date.now(),
                        requestHash,
                        replayKey,
                    },
                }
                : {}),
        };
    const rawDirectResponse = await params.postDirect({
        url: resolveDirectRpcUrl(route.endpoint.url, directRequest.v),
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        request: directRequest,
    });
    const directResponse = directRequest.v === 2
        ? PeerMachineRpcDirectResponseV2Schema.parse(rawDirectResponse)
        : PeerMachineRpcDirectResponseV1Schema.parse(rawDirectResponse);

    if (directResponse.requestId !== requestId || directResponse.method !== params.method) {
        return await useServerFallback<R, A>(
            params,
            'invalid_request',
            requestId,
            createMachineRpcPeerFallbackReceipt({
                method: params.method,
                requestId,
                reasonCode: 'invalid_request',
                receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
            }),
        );
    }
    if (!directResponse.ok) {
        return await useServerFallback<R, A>(
            params,
            directResponse.reasonCode,
            requestId,
            createMachineRpcPeerFallbackReceipt({
                method: params.method,
                requestId,
                reasonCode: directResponse.reasonCode,
                receipt: directResponse.receipt,
            }),
        );
    }

    params.recordReceipt?.({
        receipt: directResponse.receipt,
        method: params.method,
        requestId,
        routeKind: directResponse.routeKind,
    });
    return directResponse.result as R;
}
