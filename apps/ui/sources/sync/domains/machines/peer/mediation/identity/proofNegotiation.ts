import type { FeaturesResponse, PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol';

import { isLegacyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';

export type PeerRouteCallerProofNegotiation =
    | Readonly<{ kind: 'legacy_account_v1' }>
    | Readonly<{ kind: 'ephemeral_v2_endpoint_required' }>
    | Readonly<{ kind: 'ephemeral_v2' }>
    | Readonly<{ kind: 'unavailable'; reasonCode: string; requiredCapability?: string }>;

/** Single capability-intersection owner for UI peer-route caller proof selection. */
export function resolvePeerRouteCallerProofNegotiation(input: Readonly<{
    credentials: AuthCredentials;
    serverFeatures: FeaturesResponse | null;
    endpoint?: PeerLoopbackEndpointCandidateV1 | null;
}>): PeerRouteCallerProofNegotiation {
    if (isLegacyAuthCredentials(input.credentials)) return { kind: 'legacy_account_v1' };
    const serverSupportsV2 = input.serverFeatures?.capabilities.machines.peerMediation
        ?.directRouteGrantProofMintVersions.includes(2) === true;
    if (!serverSupportsV2) {
        return {
            kind: 'unavailable',
            reasonCode: 'peer_route_signing_identity_unavailable',
            requiredCapability: 'peer_route_signing_identity_v1',
        };
    }
    if (input.endpoint === undefined) return { kind: 'ephemeral_v2_endpoint_required' };
    if (input.endpoint === null) return { kind: 'unavailable', reasonCode: 'topology_unavailable' };
    if (input.endpoint.directRouteGrantProofVerifierVersions?.includes(2) !== true) {
        return {
            kind: 'unavailable',
            reasonCode: 'peer_route_ephemeral_proof_v2_unavailable',
            requiredCapability: 'peer_route_ephemeral_proof_v2',
        };
    }
    return { kind: 'ephemeral_v2' };
}
