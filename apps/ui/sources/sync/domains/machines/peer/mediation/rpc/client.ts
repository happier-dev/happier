import {
    PEER_MACHINE_RPC_DIRECT_PATH_V1,
    PEER_MEDIATION_RECEIPTS,
    PeerMachineRpcDirectResponseV1Schema,
    createPeerMachineRpcRequestHashV1,
    isMachineRpcDirectRoutePolicy,
    resolveMachineRpcRoutePolicy,
    type PeerMachineRpcDirectRequestV1,
    type PeerMachineRpcDirectResponseV1,
    type PeerRouteNonceProofV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';

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
        kind: 'fallback';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
        reasonCode: string;
    }>;

export type MachineRpcWithPeerMediationRouteParams<A> = Readonly<{
    serverId?: string | null;
    machineId: string;
    method: string;
    payload: A;
    timeoutMs?: number;
    resolveDirectRoute: (input: Readonly<{
        serverId?: string | null;
        machineId: string;
        method: string;
    }>) => Promise<MachineRpcDirectRouteResolution>;
    postDirect: (input: Readonly<{
        url: string;
        request: PeerMachineRpcDirectRequestV1;
        timeoutMs?: number;
    }>) => Promise<PeerMachineRpcDirectResponseV1>;
    serverFallback: (input: Readonly<{
        serverId?: string | null;
        machineId: string;
        method: string;
        payload: A;
        timeoutMs?: number;
        reasonCode: string;
    }>) => Promise<unknown>;
    recordReceipt?: (receipt: Readonly<Record<string, unknown>>) => void;
    createRequestId?: () => string;
}>;

function createRequestId(): string {
    return `rpc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function resolveDirectRpcUrl(endpointUrl: string): string {
    const parsed = new URL(endpointUrl);
    parsed.pathname = PEER_MACHINE_RPC_DIRECT_PATH_V1;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
}

async function useServerFallback<R, A>(
    params: MachineRpcWithPeerMediationRouteParams<A>,
    reasonCode: string,
    requestId?: string,
    receipt?: MachineRpcPeerFallbackReceipt,
): Promise<R> {
    params.recordReceipt?.(receipt ?? createMachineRpcPeerFallbackReceipt({
        method: params.method,
        requestId,
        reasonCode,
    }));
    return await params.serverFallback({
        serverId: params.serverId,
        machineId: params.machineId,
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        reasonCode,
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
    const directResponse = PeerMachineRpcDirectResponseV1Schema.parse(await params.postDirect({
        url: resolveDirectRpcUrl(route.endpoint.url),
        timeoutMs: params.timeoutMs,
        request: {
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
                        v: 1,
                        issuer: 'ui',
                        issuedAtMs: Date.now(),
                        requestHash,
                        replayKey,
                    },
                }
                : {}),
        },
    }));

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
