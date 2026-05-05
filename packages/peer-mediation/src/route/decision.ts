import type { PeerFlowKind, PeerRouteCandidate, PeerRouteDecision, PeerRouteKind } from './types.js';

export function resolvePeerRouteDecision(input: Readonly<{
    flowKind: PeerFlowKind;
    preferredRouteKinds: readonly PeerRouteKind[];
    candidates: readonly PeerRouteCandidate[];
}>): PeerRouteDecision {
    for (const routeKind of input.preferredRouteKinds) {
        for (const candidate of input.candidates) {
            if (candidate.routeKind !== routeKind) continue;
            if (!candidate.enabled) continue;
            if (candidate.viability?.status === 'unavailable') continue;

            return {
                kind: 'selected',
                flowKind: input.flowKind,
                routeKind: candidate.routeKind,
                ...(candidate.endpoint ? { endpoint: candidate.endpoint } : {}),
                ...(candidate.viability ? { viability: candidate.viability } : {}),
            };
        }
    }

    return {
        kind: 'unavailable',
        flowKind: input.flowKind,
        reasonCode: 'no_routes_available',
    };
}
