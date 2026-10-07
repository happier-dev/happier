import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PeerLoopbackEndpointCandidateV1Schema, type PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { PeerDirectPreference } from '@happier-dev/peer-mediation';
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
        proofKind: 'ephemeral_v2';
    }>
    | Readonly<{ kind: 'credentials_required' }>
    | Readonly<{ kind: 'endpoint_required' }>
    | MachineRpcDirectRouteFallback;

function fallback(reasonCode: string): MachineRpcDirectRouteFallback {
    return {
        kind: 'fallback',
        receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
        reasonCode,
    };
}

/**
 * Pure, passive direct-route preflight shared by settings readiness and the
 * real machine-RPC route. Grant minting remains Start-time
 * work in resolveProductionMachineRpcDirectRoute.
 */
export function resolveMachineRpcDirectRoutePreflight(input: Readonly<{
    method: string;
    serverFeatures: FeaturesResponse | null;
    credentials?: AuthCredentials | null;
    endpoint?: unknown;
    accountMachinePreference?: PeerDirectPreference;
    accountDefaultPreference?: PeerDirectPreference;
}>): MachineRpcDirectRoutePreflight {
    const policyDecision = resolveMachineRpcPeerRouteDecision({
        method: input.method,
        serverFeatures: input.serverFeatures,
        grantStatus: 'valid',
        accountMachinePreference: input.accountMachinePreference,
        accountDefaultPreference: input.accountDefaultPreference,
    });
    if (policyDecision.kind !== 'direct_allowed') {
        return fallback(policyDecision.reasonCode);
    }
    if (input.credentials === undefined) return { kind: 'credentials_required' };
    if (!input.credentials) return fallback('grant_missing');

    if (input.endpoint === undefined) return { kind: 'endpoint_required' };
    const parsedEndpoint = PeerLoopbackEndpointCandidateV1Schema.safeParse(input.endpoint);
    return parsedEndpoint.success
        ? {
            kind: 'direct_eligible',
            endpoint: parsedEndpoint.data,
            proofKind: 'ephemeral_v2',
        }
        : fallback('topology_unavailable');
}
