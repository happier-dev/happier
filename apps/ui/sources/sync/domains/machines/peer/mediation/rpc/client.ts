import { PEER_MACHINE_RPC_DIRECT_PATH_V2, PeerMachineRpcDirectResponseV2Schema, type PeerMachineRpcDirectRequestV2, type PeerMachineRpcDirectResponseV2 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { createPeerMachineRpcRequestHashV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/commandReceiptV1';
import { isMachineRpcDirectRoutePolicy, resolveMachineRpcRelayFallbackDecision, resolveMachineRpcRoutePolicy, type MachineRpcRelayFallbackDecision, type MachineRpcRoutePolicyV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { PeerRouteEphemeralProofV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import type { SignedDirectRouteGrantV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { markRpcRequestDisposition, readRpcRequestDisposition } from '@happier-dev/sync-client';

import { createMachineRpcPeerFallbackReceipt, type MachineRpcPeerFallbackReceipt } from './fallback';

export type MachineRpcDirectRouteResolution =
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
    accountId?: string | null;
    machineId: string;
    method: string;
    payload: A;
    timeoutMs?: number;
    operationTimeoutMs?: null;
    authorization?: SocketRpcAuthorizationContext;
    /**
     * Caller abort signal. Forwarded to the direct transport (`postDirect`) so a
     * cancelled RPC propagates uniformly on the direct peer route as well as the
     * server-fallback route. Prompt rejection on abort is owned by the injected
     * transports, mirroring `serverFallback`.
     */
    signal?: AbortSignal;
    onDispatched?: () => void;
    resolveDirectRoute: (input: Readonly<{
        serverId?: string | null;
        accountId?: string | null;
        machineId: string;
        method: string;
    }>) => Promise<MachineRpcDirectRouteResolution>;
    postDirect: (input: Readonly<{
        url: string;
        request: PeerMachineRpcDirectRequestV2;
        timeoutMs?: number;
        operationTimeoutMs?: null;
        signal?: AbortSignal;
        onDispatched?: () => void;
    }>) => Promise<PeerMachineRpcDirectResponseV2>;
    serverFallback: (input: Readonly<{
        serverId?: string | null;
        accountId?: string | null;
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
        serverId?: string | null;
        accountId?: string | null;
        policy: Pick<MachineRpcRoutePolicyV1, 'relayFallback'>;
    }>) => MachineRpcRelayFallbackDecision | Promise<MachineRpcRelayFallbackDecision>;
    recordReceipt?: (receipt: Readonly<Record<string, unknown>>) => void;
    createRequestId?: () => string;
}>;

function createRequestId(): string {
    return `rpc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/** No cause/message bag may escape a confidential transport boundary. */
export function createPrivateContinuationTransportError(cause: unknown, issued = false): Error {
    const disposition = readRpcRequestDisposition(cause);
    const uncertain = issued || (disposition !== null && disposition !== undefined && disposition !== 'notSent');
    const code = uncertain ? 'outcome_uncertain' : 'target_unavailable';
    const error = Object.assign(new Error(code), { code });
    markRpcRequestDisposition(error, uncertain ? 'outcomeUnknown' : 'notSent');
    return error;
}

function resolveDirectRpcUrl(endpointUrl: string): string {
    const parsed = new URL(endpointUrl);
    parsed.pathname = PEER_MACHINE_RPC_DIRECT_PATH_V2;
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
            serverId: params.serverId,
            accountId: params.accountId,
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
        accountId: params.accountId,
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
    const confidential = params.method === RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE;
    if (confidential) params = { ...params, recordReceipt: undefined };
    let issued = false;
    try {
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
        accountId: params.accountId,
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

    // Old grants carry no authenticated human authority. Use the incumbent
    // authenticated relay before delivering anything to that direct endpoint.
    if (confidential && route.grant.payload.callerAuthority !== 'present_user') {
        return await useServerFallback<R, A>(params, 'direct_authority_unavailable');
    }

    params.recordReceipt?.({
        receipt: route.receipt,
        method: params.method,
        requestId,
        routeKind: 'loopback_direct',
        endpointFingerprint: route.endpoint.endpointFingerprint,
    });

    const replayKey = requestId;
    const requestHash = policy.commandReceiptRequired ? createPeerMachineRpcRequestHashV1({
        method: params.method,
        params: params.payload,
        grantId: route.grant.payload.grantId,
        endpointFingerprint: route.endpoint.endpointFingerprint,
        replayKey,
    }) : undefined;
    const directRequest: PeerMachineRpcDirectRequestV2 = {
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
                        requestHash: requestHash!,
                        replayKey,
                    },
                }
                : {}),
        };
    const rawDirectResponse = await params.postDirect({
        url: resolveDirectRpcUrl(route.endpoint.url),
        timeoutMs: params.timeoutMs,
        operationTimeoutMs: params.operationTimeoutMs,
        signal: params.signal,
        onDispatched: () => { issued = true; params.onDispatched?.(); },
        request: directRequest,
    });
    if (confidential) issued = true;
    const directResponse = PeerMachineRpcDirectResponseV2Schema.parse(rawDirectResponse);

    if (directResponse.requestId !== requestId || directResponse.method !== params.method) {
        if (confidential) throw createPrivateContinuationTransportError(null, true);
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
        if (confidential) throw createPrivateContinuationTransportError(null, true);
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
    } catch (error) {
        if (confidential) throw createPrivateContinuationTransportError(error, issued);
        throw error;
    }
}
