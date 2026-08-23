import {
    peerMediationObservabilityScopeKey,
    peerMediationObservabilityScopesEqual,
    type PeerMediationObservabilityFlowRefV1,
    type PeerMediationObservabilityScopeV1,
} from '@happier-dev/protocol';

/**
 * Scope identity is owned by protocol (`scopeIdentity.ts`) so the UI, the daemon store and the
 * server store cannot drift apart on what "the same scope" means (DEC-8). Only the UI-specific
 * machine/flow keys live here.
 */
export {
    peerMediationObservabilityScopeKey,
    peerMediationObservabilityScopesEqual,
};

export function peerMediationObservabilityMachineKey(
    scope: PeerMediationObservabilityScopeV1,
): string {
    if (scope.kind === 'machine') {
        return scope.machineId;
    }
    return peerMediationObservabilityScopeKey(scope);
}

export function peerMediationObservabilityFlowKey(
    scope: PeerMediationObservabilityScopeV1,
    flow: PeerMediationObservabilityFlowRefV1,
): string {
    return [
        peerMediationObservabilityMachineKey(scope),
        flow.flowKind,
        flow.flowId,
    ].join(':');
}
