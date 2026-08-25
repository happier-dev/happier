import {
    PEER_MEDIATION_RECEIPTS,
    isMachineRpcDirectRoutePolicy,
    readServerEnabledBit,
    resolveMachineRpcRoutePolicy,
    type FeaturesResponse,
    type PeerMachineRpcDirectFallbackReasonCodeV1,
} from '@happier-dev/protocol';
import {
    resolveEffectivePeerDirectRoutePolicy,
    type PeerDirectPreference,
    type PeerDirectRouteGrantStatus,
} from '@happier-dev/peer-mediation';

export type MachineRpcPeerRouteDecision =
    | Readonly<{
        kind: 'server_required';
        receipt: typeof PEER_MEDIATION_RECEIPTS.rpcFellBackToServer;
        reasonCode: PeerMachineRpcDirectFallbackReasonCodeV1;
    }>
    | Readonly<{
        kind: 'direct_allowed';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeSelected;
    }>
    | Readonly<{
        kind: 'fallback';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
        reasonCode: string;
    }>;

export type ResolveMachineRpcPeerRouteDecisionInput = Readonly<{
    method: string;
    serverFeatures: FeaturesResponse | null;
    daemonPolicy?: boolean | null;
    accountMachinePreference?: PeerDirectPreference;
    accountDefaultPreference?: PeerDirectPreference;
    productDefaultPreference?: Exclude<PeerDirectPreference, 'inherit'>;
    grantStatus: PeerDirectRouteGrantStatus;
}>;

function resolveServerRequiredReason(method: string): PeerMachineRpcDirectFallbackReasonCodeV1 {
    const policy = resolveMachineRpcRoutePolicy(method);
    return policy.serverRequiredReason === 'unclassified' ? 'method_unclassified' : 'server_required';
}

export function resolveMachineRpcPeerRouteDecision(
    input: ResolveMachineRpcPeerRouteDecisionInput,
): MachineRpcPeerRouteDecision {
    const methodPolicy = resolveMachineRpcRoutePolicy(input.method);
    if (!isMachineRpcDirectRoutePolicy(methodPolicy)) {
        return {
            kind: 'server_required',
            receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer,
            reasonCode: resolveServerRequiredReason(input.method),
        };
    }

    const serverGateEnabled = input.serverFeatures
        ? readServerEnabledBit(input.serverFeatures, 'machines.rpc.directPeer') === true
        : false;
    const policy = resolveEffectivePeerDirectRoutePolicy({
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        serverGateEnabled,
        daemonPolicy: input.daemonPolicy ?? null,
        accountMachinePreference: input.accountMachinePreference ?? 'inherit',
        accountDefaultPreference: input.accountDefaultPreference ?? 'inherit',
        productDefaultPreference: input.productDefaultPreference ?? 'enabled',
        grant: { status: input.grantStatus },
    });

    if (!policy.allowed) {
        return {
            kind: 'fallback',
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            reasonCode: policy.reasonCode,
        };
    }
    return {
        kind: 'direct_allowed',
        receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
    };
}
