import type {
    PeerMediationObservabilityFlowRefV1,
    PeerMediationObservabilityScopeV1,
} from '@happier-dev/protocol';

export function peerMediationObservabilityScopeKey(scope: PeerMediationObservabilityScopeV1): string {
    switch (scope.kind) {
        case 'account':
            return `account:${scope.accountId}`;
        case 'machine':
            return `machine:${scope.accountId}:${scope.machineId}`;
        case 'session':
            return `session:${scope.accountId}:${scope.sessionId}`;
        case 'publicPreview':
            return `publicPreview:${scope.publicExposureId}`;
        case 'pluginSurface':
            return `pluginSurface:${scope.accountId}:${scope.pluginId}:${scope.surfaceId}`;
    }
}

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

export function peerMediationObservabilityScopesEqual(
    left: PeerMediationObservabilityScopeV1,
    right: PeerMediationObservabilityScopeV1,
): boolean {
    return peerMediationObservabilityScopeKey(left) === peerMediationObservabilityScopeKey(right);
}
