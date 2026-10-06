import { SignedProviderBrokerRouteGrantV1Schema, createProviderBrokerRouteGrantSigningInputV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerRouteGrantPayloadV1, SignedProviderBrokerRouteGrantV1 } from '@happier-dev/protocol';
import { findRouteGrantTrustRoot, verifyRouteGrantSignature, type DirectRouteGrantTrustRoot } from './verifyRouteGrantSignature';

export type ProviderBrokerRouteGrantExpectedBindingV1 = Pick<ProviderBrokerRouteGrantPayloadV1,
    'teamId' | 'resourceId' | 'sourceRevision' | 'brokerPlacementFingerprint' | 'initiator' | 'target' | 'consumer' | 'application'>;

/** The signed identity of one broker operation, as every carrier and handler
 * binds it. The model is deliberately not part of it: it is a current request
 * fact (`04-private-iroh-broker-transport.md:270`). */
export function providerBrokerRouteGrantExpectedBindingV1(
    authority: SignedProviderBrokerRouteGrantV1,
): ProviderBrokerRouteGrantExpectedBindingV1 {
    const { payload } = authority;
    return {
        teamId: payload.teamId,
        resourceId: payload.resourceId,
        sourceRevision: payload.sourceRevision,
        brokerPlacementFingerprint: payload.brokerPlacementFingerprint,
        initiator: payload.initiator,
        target: payload.target,
        consumer: payload.consumer,
        application: payload.application,
    };
}
export type ProviderBrokerRouteGrantVerificationResultV1 =
    | Readonly<{ valid: true; authority: SignedProviderBrokerRouteGrantV1 }>
    | Readonly<{ valid: false; reasonCode: 'grant_invalid' | 'grant_unknown_key' | 'grant_bad_signature' | 'grant_expired' | 'grant_not_yet_valid' | 'grant_binding_mismatch' | 'transport_identity_mismatch' }>;

/** Transport admission only. Current Home resource/consumer admission must precede
 * application dispatch. The handler must retain this exact admitted authority
 * in trusted stream context and compare the request authority to it.
 *
 * QUIC authenticates possession of the signed initiator EndpointId. Existing
 * generic V2 peer proofs and their consumers remain unchanged.
 * Repeated admission is intentional: each HTTP connection opens another stream.
 */
export function verifyProviderBrokerRouteGrantV1(input: Readonly<{
    authority: unknown;
    trustRoots: readonly DirectRouteGrantTrustRoot[];
    nowMs: number;
    /** Carrier admission checks expiry once. Application requests on that
     * already-authenticated stream retain signature/binding checks without
     * turning the grant TTL into an operation or request lifetime. */
    enforceExpiry?: boolean;
    expected: ProviderBrokerRouteGrantExpectedBindingV1;
    /** Required transport-observed initiator identity, never a request claim. */
    authenticatedRemoteEndpointId: string;
}>): ProviderBrokerRouteGrantVerificationResultV1 {
    const parsed = SignedProviderBrokerRouteGrantV1Schema.safeParse(input.authority);
    if (!parsed.success) return { valid: false, reasonCode: 'grant_invalid' };
    const authority = parsed.data;
    const publicKey = findRouteGrantTrustRoot(input.trustRoots, authority.signature.keyId, input.nowMs);
    if (!publicKey) return { valid: false, reasonCode: 'grant_unknown_key' };
    if (!verifyRouteGrantSignature({ signingInput: createProviderBrokerRouteGrantSigningInputV1(authority.payload), signatureBase64Url: authority.signature.valueBase64Url, publicKey })) {
        return { valid: false, reasonCode: 'grant_bad_signature' };
    }
    if (input.enforceExpiry !== false && input.nowMs >= authority.payload.expiresAt) {
        return { valid: false, reasonCode: 'grant_expired' };
    }
    if (input.nowMs < authority.payload.issuedAt) return { valid: false, reasonCode: 'grant_not_yet_valid' };
    const payload = authority.payload;
    const expected = input.expected;
    if (
        payload.teamId !== expected.teamId
        || payload.resourceId !== expected.resourceId
        || payload.sourceRevision !== expected.sourceRevision
        || payload.brokerPlacementFingerprint !== expected.brokerPlacementFingerprint
        || payload.initiator.accountId !== expected.initiator.accountId
        || payload.initiator.machineId !== expected.initiator.machineId
        || payload.initiator.endpointId !== expected.initiator.endpointId
        || payload.target.custodianAccountId !== expected.target.custodianAccountId
        || payload.target.machineId !== expected.target.machineId
        || payload.target.endpointId !== expected.target.endpointId
        || payload.application.agentTargetKey !== expected.application.agentTargetKey
        || payload.application.implementationIdentity.pluginId !== expected.application.implementationIdentity.pluginId
        || payload.application.implementationIdentity.localId !== expected.application.implementationIdentity.localId
        || payload.application.endpointTemplateId !== expected.application.endpointTemplateId
        || payload.application.protocol !== expected.application.protocol
        || payload.consumer.kind !== expected.consumer.kind
        || (payload.consumer.kind === 'session'
            && (expected.consumer.kind !== 'session' || payload.consumer.sessionId !== expected.consumer.sessionId))
        || (payload.consumer.kind === 'execution_run'
            && (expected.consumer.kind !== 'execution_run' || payload.consumer.executionRunId !== expected.consumer.executionRunId))
    ) {
        return { valid: false, reasonCode: 'grant_binding_mismatch' };
    }
    if (input.authenticatedRemoteEndpointId !== payload.initiator.endpointId) {
        return { valid: false, reasonCode: 'transport_identity_mismatch' };
    }
    return { valid: true, authority };
}
