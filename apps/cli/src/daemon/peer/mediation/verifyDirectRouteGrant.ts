import { SignedDirectRouteGrantV2Schema, createDirectRouteGrantSigningInputV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { verifyPeerRouteEphemeralProofV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import type { AuthorizedPeerEndpointRouteKindV1, IrohPeerRouteBindingV2, PeerFlowKindV1, SignedDirectRouteGrantV2 } from '@happier-dev/protocol';

import { findRouteGrantTrustRoot as findTrustRoot, verifyRouteGrantSignature, type DirectRouteGrantTrustRoot } from './verifyRouteGrantSignature';

export type DirectRouteGrantVerifyReasonCode =
    | 'grant_invalid'
    | 'grant_unknown_key'
    | 'grant_bad_signature'
    | 'grant_expired'
    | 'grant_not_yet_valid'
    | 'grant_revoked'
    | 'grant_account_mismatch'
    | 'grant_machine_mismatch'
    | 'grant_flow_mismatch'
    | 'grant_route_mismatch'
    | 'grant_endpoint_mismatch'
    | 'grant_iroh_binding_mismatch';

export type DirectRouteGrantV2VerifyReasonCode = DirectRouteGrantVerifyReasonCode
    | 'proof_invalid'
    | 'proof_grant_invalid'
    | 'proof_grant_digest_mismatch'
    | 'proof_bad_signature';

export type DirectRouteGrantV2VerificationResult =
    | Readonly<{ valid: true; payload: SignedDirectRouteGrantV2['payload']; receipt: 'peer.route_grant.verified' }>
    | Readonly<{ valid: false; reasonCode: DirectRouteGrantV2VerifyReasonCode; receipt?: 'peer.route_grant.rejected' }>;

export type { DirectRouteGrantTrustRoot } from './verifyRouteGrantSignature';

/** Full signed machine/1 initiator/target relationship expected for `iroh_peer` admissions. */
export type DirectRouteGrantIrohExpectedBinding = IrohPeerRouteBindingV2;

export type DirectRouteGrantExpectedBinding = Readonly<{
    accountId: string;
    machineId: string;
    flowKind: PeerFlowKindV1;
    routeKind: AuthorizedPeerEndpointRouteKindV1;
    endpointFingerprint?: string;
    /**
     * Required when `routeKind` is `iroh_peer` and forbidden otherwise: the full signed machine/1
     * relationship. The target daemon supplies its current Machine and Endpoint identities;
     * authenticated Account clients have no synthetic source Machine identity.
     */
    iroh?: DirectRouteGrantIrohExpectedBinding;
}>;

function matchesExpectedBinding(
    payload: SignedDirectRouteGrantV2['payload'],
    expected: DirectRouteGrantExpectedBinding,
): DirectRouteGrantVerifyReasonCode | null {
    if (payload.accountId !== expected.accountId) return 'grant_account_mismatch';
    if (payload.machineId !== expected.machineId) return 'grant_machine_mismatch';
    if (payload.flowKind !== expected.flowKind) return 'grant_flow_mismatch';
    if (payload.routeKind !== expected.routeKind) return 'grant_route_mismatch';
    if (expected.endpointFingerprint && payload.endpointFingerprint !== expected.endpointFingerprint) {
        return 'grant_endpoint_mismatch';
    }
    if (expected.routeKind === 'iroh_peer' || expected.iroh) {
        const grantIroh = 'iroh' in payload ? payload.iroh : undefined;
        if (
            !expected.iroh
            || !grantIroh
            || grantIroh.initiator.kind !== expected.iroh.initiator.kind
            || grantIroh.initiator.endpointId !== expected.iroh.initiator.endpointId
            || (
                grantIroh.initiator.kind === 'machine'
                && (
                    expected.iroh.initiator.kind !== 'machine'
                    || grantIroh.initiator.machineId !== expected.iroh.initiator.machineId
                )
            )
            || grantIroh.target.machineId !== expected.iroh.target.machineId
            || grantIroh.target.endpointId !== expected.iroh.target.endpointId
            || grantIroh.operationKind !== expected.iroh.operationKind
        ) {
            return 'grant_iroh_binding_mismatch';
        }
    }
    return null;
}

export function verifyDirectRouteGrantV2(input: Readonly<{
    grant: unknown;
    proof: unknown;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    nowMs: number;
    expected: DirectRouteGrantExpectedBinding;
}>): DirectRouteGrantV2VerificationResult {
    const parsed = SignedDirectRouteGrantV2Schema.safeParse(input.grant);
    if (!parsed.success) return { valid: false, reasonCode: 'grant_invalid', receipt: 'peer.route_grant.rejected' };

    const grant = parsed.data;
    const publicKey = findTrustRoot(input.trustRoots, grant.signature.keyId, input.nowMs);
    if (!publicKey) return { valid: false, reasonCode: 'grant_unknown_key' };
    if (grant.payload.exp !== null && input.nowMs >= grant.payload.exp) return { valid: false, reasonCode: 'grant_expired' };
    if (input.nowMs < grant.payload.iat) return { valid: false, reasonCode: 'grant_not_yet_valid' };

    const bindingMismatch = matchesExpectedBinding(grant.payload, input.expected);
    if (bindingMismatch) return { valid: false, reasonCode: bindingMismatch };
    if (!verifyRouteGrantSignature({ signingInput: createDirectRouteGrantSigningInputV2(grant.payload), signatureBase64Url: grant.signature.valueBase64Url, publicKey })) {
        return { valid: false, reasonCode: 'grant_bad_signature' };
    }
    const proofVerification = verifyPeerRouteEphemeralProofV2({ grant, proof: input.proof });
    if (!proofVerification.valid) return proofVerification;
    return { valid: true, payload: grant.payload, receipt: 'peer.route_grant.verified' };
}
