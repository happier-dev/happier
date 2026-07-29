import {
    PEER_MEDIATION_RECEIPTS,
    type PeerMachineRpcDirectFallbackReasonCodeV1,
} from '@happier-dev/protocol';

export type MachineRpcPeerFallbackReceipt = Readonly<{
    receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback | typeof PEER_MEDIATION_RECEIPTS.rpcFellBackToServer;
    method: string;
    requestId?: string;
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1 | string;
    routeKind: 'server_relay';
}>;

export function createMachineRpcPeerFallbackReceipt(input: Readonly<{
    method: string;
    requestId?: string;
    reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1 | string;
    receipt?: typeof PEER_MEDIATION_RECEIPTS.routeFallback | typeof PEER_MEDIATION_RECEIPTS.rpcFellBackToServer;
}>): MachineRpcPeerFallbackReceipt {
    return {
        receipt: input.receipt ?? PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
        method: input.method,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        reasonCode: input.reasonCode,
        routeKind: 'server_relay',
    };
}
