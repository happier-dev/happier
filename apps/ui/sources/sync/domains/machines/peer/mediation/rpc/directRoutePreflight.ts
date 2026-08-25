import {
    PEER_MEDIATION_RECEIPTS,
    PeerLoopbackEndpointCandidateV1Schema,
    type FeaturesResponse,
    type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import { resolvePeerRouteCallerProofNegotiation } from '../identity/proofNegotiation';
import { resolvePeerRouteSigningReadiness } from '../identity/signingReadiness';
import type { MachineRpcDirectRouteResolution } from './client';
import { resolveMachineRpcPeerRouteDecision } from './routeDecision';

type MachineRpcDirectRouteFallback = Extract<
    MachineRpcDirectRouteResolution,
    { kind: 'fallback' }
>;

export type MachineRpcDirectRoutePreflight =
    | Readonly<{
        kind: 'direct_eligible';
        endpoint: PeerLoopbackEndpointCandidateV1;
        proofKind: 'legacy_account_v1' | 'ephemeral_v2';
    }>
    | Readonly<{ kind: 'credentials_required' }>
    | Readonly<{ kind: 'endpoint_required' }>
    | MachineRpcDirectRouteFallback;

function fallback(
    reasonCode: string,
    details?: Readonly<{ requiredCapability: string }>,
): MachineRpcDirectRouteFallback {
    return {
        kind: 'fallback',
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode,
        ...details,
    };
}

/**
 * Pure, passive direct-route preflight shared by settings readiness and the
 * real machine-RPC route. Grant minting and loopback probing remain Start-time
 * work in resolveProductionMachineRpcDirectRoute.
 */
export function resolveMachineRpcDirectRoutePreflight(input: Readonly<{
    method: string;
    serverFeatures: FeaturesResponse | null;
    credentials?: AuthCredentials | null;
    endpoint?: unknown;
}>): MachineRpcDirectRoutePreflight {
    const policyDecision = resolveMachineRpcPeerRouteDecision({
        method: input.method,
        serverFeatures: input.serverFeatures,
        grantStatus: 'valid',
    });
    if (policyDecision.kind !== 'direct_allowed') {
        return fallback(policyDecision.reasonCode);
    }
    if (input.credentials === undefined) return { kind: 'credentials_required' };
    if (!input.credentials) return fallback('grant_missing');

    const signingReadiness = resolvePeerRouteSigningReadiness(input.credentials);
    if (signingReadiness.status === 'unavailable') {
        const proofPreflight = resolvePeerRouteCallerProofNegotiation({
            credentials: input.credentials,
            serverFeatures: input.serverFeatures,
        });
        if (proofPreflight.kind === 'unavailable') {
            return fallback(
                proofPreflight.reasonCode,
                proofPreflight.requiredCapability
                    ? { requiredCapability: proofPreflight.requiredCapability }
                    : undefined,
            );
        }
        if (proofPreflight.kind !== 'ephemeral_v2_endpoint_required') {
            return fallback('grant_invalid');
        }
        if (input.endpoint === undefined) return { kind: 'endpoint_required' };

        const parsedEndpoint = PeerLoopbackEndpointCandidateV1Schema.safeParse(input.endpoint);
        const endpoint = parsedEndpoint.success ? parsedEndpoint.data : null;
        const negotiation = resolvePeerRouteCallerProofNegotiation({
            credentials: input.credentials,
            serverFeatures: input.serverFeatures,
            endpoint,
        });
        if (negotiation.kind === 'unavailable') {
            return fallback(
                negotiation.reasonCode,
                negotiation.requiredCapability
                    ? { requiredCapability: negotiation.requiredCapability }
                    : undefined,
            );
        }
        return negotiation.kind === 'ephemeral_v2' && endpoint
            ? { kind: 'direct_eligible', endpoint, proofKind: 'ephemeral_v2' }
            : fallback('grant_invalid');
    }

    if (input.endpoint === undefined) return { kind: 'endpoint_required' };
    const parsedEndpoint = PeerLoopbackEndpointCandidateV1Schema.safeParse(input.endpoint);
    return parsedEndpoint.success
        ? {
            kind: 'direct_eligible',
            endpoint: parsedEndpoint.data,
            proofKind: 'legacy_account_v1',
        }
        : fallback('topology_unavailable');
}
