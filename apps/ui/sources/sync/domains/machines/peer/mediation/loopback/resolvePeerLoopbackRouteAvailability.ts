import {
    PEER_MEDIATION_RECEIPTS,
    PeerLoopbackEndpointCandidateV1Schema,
    type DirectPeerRouteKindV1,
    type PeerFlowKindV1,
    type PeerLoopbackEndpointCandidateV1,
    type PeerLoopbackProbeRequestV1,
    type PeerLoopbackProbeResponseV1,
    type PeerRouteNonceProofV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import type { PeerRouteViabilityCache } from '@happier-dev/peer-mediation';

export type PeerLoopbackRouteAvailabilityResult =
    | Readonly<{
        kind: 'selected';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeSelected;
        routeKind: 'loopback_direct';
        flowKind: PeerFlowKindV1;
        endpointFingerprint: string;
        grant?: SignedDirectRouteGrantV1;
        nonceProof?: PeerRouteNonceProofV1;
    }>
    | Readonly<{
        kind: 'fallback';
        receipt: typeof PEER_MEDIATION_RECEIPTS.routeFallback;
        reasonCode: string;
    }>;

type OperationResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; reasonCode: string }>;

export type ResolvePeerLoopbackRouteAvailabilityInput = Readonly<{
    serverId: string;
    targetMachineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: DirectPeerRouteKindV1;
    endpoint: PeerLoopbackEndpointCandidateV1 | null;
    cache: PeerRouteViabilityCache;
    requestGrant: (input: Readonly<{
        machineId: string;
        flowKind: PeerFlowKindV1;
        routeKind: DirectPeerRouteKindV1;
        endpointFingerprint: string;
    }>) => Promise<Readonly<{ ok: true; grant: SignedDirectRouteGrantV1 }> | Readonly<{ ok: false; reasonCode: string }>>;
    createNonceProof: (input: Readonly<{
        grant: SignedDirectRouteGrantV1;
        routeKind: DirectPeerRouteKindV1;
        flowKind: PeerFlowKindV1;
        endpointFingerprint: string;
    }>) => Promise<Readonly<{ ok: true; nonceProof: PeerRouteNonceProofV1 }> | Readonly<{ ok: false; reasonCode: string }>>;
    postProbe: (input: Readonly<{
        url: string;
        request: PeerLoopbackProbeRequestV1;
    }>) => Promise<PeerLoopbackProbeResponseV1>;
}>;

function fallback(reasonCode: string): PeerLoopbackRouteAvailabilityResult {
    return {
        kind: 'fallback',
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode,
    };
}

function normalizeEndpoint(
    endpoint: PeerLoopbackEndpointCandidateV1 | null,
): OperationResult<PeerLoopbackEndpointCandidateV1> {
    const parsed = PeerLoopbackEndpointCandidateV1Schema.safeParse(endpoint);
    if (!parsed.success) return { ok: false, reasonCode: 'endpoint_invalid' };
    return { ok: true, value: parsed.data };
}

export async function resolvePeerLoopbackRouteAvailability(
    input: ResolvePeerLoopbackRouteAvailabilityInput,
): Promise<PeerLoopbackRouteAvailabilityResult> {
    const endpoint = normalizeEndpoint(input.endpoint);
    if (!endpoint.ok) return fallback(endpoint.reasonCode);

    const cacheKey = {
        serverId: input.serverId,
        targetMachineId: input.targetMachineId,
        flowKind: input.flowKind,
        routeKind: input.routeKind,
        endpointFingerprint: endpoint.value.endpointFingerprint,
    };
    const cached = input.cache.read(cacheKey);
    if (cached.status === 'viable') {
        return {
            kind: 'selected',
            receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
            routeKind: 'loopback_direct',
            flowKind: input.flowKind,
            endpointFingerprint: endpoint.value.endpointFingerprint,
        };
    }
    if (cached.status === 'unavailable') {
        return fallback(cached.failureReason);
    }

    const grant = await input.requestGrant({
        machineId: input.targetMachineId,
        flowKind: input.flowKind,
        routeKind: input.routeKind,
        endpointFingerprint: endpoint.value.endpointFingerprint,
    });
    if (!grant.ok) {
        input.cache.recordUnavailable(cacheKey, grant.reasonCode);
        return fallback(grant.reasonCode);
    }

    const nonceProof = await input.createNonceProof({
        grant: grant.grant,
        routeKind: input.routeKind,
        flowKind: input.flowKind,
        endpointFingerprint: endpoint.value.endpointFingerprint,
    });
    if (!nonceProof.ok) {
        input.cache.recordUnavailable(cacheKey, nonceProof.reasonCode);
        return fallback(nonceProof.reasonCode);
    }

    const probe = await input.postProbe({
        url: endpoint.value.url,
        request: {
            v: 1,
            grant: grant.grant,
            nonceProof: nonceProof.nonceProof,
        },
    });
    if (!probe.ok) {
        input.cache.recordUnavailable(cacheKey, probe.reasonCode);
        return fallback(probe.reasonCode);
    }
    if (
        probe.routeKind !== 'loopback_direct'
        || probe.flowKind !== input.flowKind
        || probe.endpointFingerprint !== endpoint.value.endpointFingerprint
    ) {
        input.cache.recordUnavailable(cacheKey, 'probe_binding_mismatch');
        return fallback('probe_binding_mismatch');
    }

    input.cache.recordViable(cacheKey);
    return {
        kind: 'selected',
        receipt: probe.receipt,
        routeKind: probe.routeKind,
        flowKind: probe.flowKind,
        endpointFingerprint: probe.endpointFingerprint,
        grant: grant.grant,
        nonceProof: nonceProof.nonceProof,
    };
}
