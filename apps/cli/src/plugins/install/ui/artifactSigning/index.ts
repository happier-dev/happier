import tweetnacl from 'tweetnacl';

import {
    createPluginUiArtifactSignaturePayloadV1,
    createPluginUiArtifactSignatureSigningInputV1,
    encodeBase64,
    hasPluginUiExecutableArtifactIntegrityV1,
    PluginUiExecutableArtifactManifestV1Schema,
    verifyPluginUiArtifactSignatureForArtifactV1,
    type PluginUiArtifactSignatureEnvelopeV1,
    type PluginUiArtifactTrustRootV1,
    type PluginUiExecutableArtifactManifestWithIntegrityV1,
} from '@happier-dev/protocol';

import {
    createPluginUiArtifactRevocationState,
    isPluginUiArtifactRevoked,
    type PluginUiArtifactRevocationState,
} from '../revocation';

export type PluginUiArtifactTrustedSourceReason =
    | 'first_party'
    | 'bundled'
    | 'local_trusted'
    | 'host_runtime';

export type PluginUiArtifactExecutionTrust =
    | Readonly<{
        kind: 'trustedSource';
        reason: PluginUiArtifactTrustedSourceReason;
        sourceKind?: string;
    }>
    | Readonly<{
        kind: 'verifiedSignature';
        signature: string;
        signingKeyId: string;
        trustRootId: string;
        canonicalPayload?: string;
    }>;

export type PluginUiArtifactTrustValidationCode =
    | 'execution_trust_unverified'
    | 'signature_verification_unavailable'
    | 'signature_required'
    | 'signing_key_required'
    | 'signature_mismatch'
    | 'signing_key_mismatch'
    | 'artifact_revoked';

export type PluginUiArtifactTrustResolutionCode =
    | 'invalid_manifest'
    | 'signature_required'
    | 'signing_key_required'
    | 'trust_root_missing'
    | 'trust_root_revoked'
    | 'signing_key_revoked'
    | 'artifact_revoked'
    | 'signature_invalid'
    | 'signature_payload_mismatch';

export type PluginUiArtifactTrustResolutionResult =
    | Readonly<{
        ok: true;
        executionTrust: PluginUiArtifactExecutionTrust;
    }>
    | Readonly<{ ok: false; code: PluginUiArtifactTrustResolutionCode }>;

export type PluginUiArtifactSigningKeyPair = Readonly<{
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}>;

export type SignPluginUiArtifactManifestResult = Readonly<{
    artifact: PluginUiExecutableArtifactManifestWithIntegrityV1;
    signature: PluginUiArtifactSignatureEnvelopeV1;
    trustRoot: PluginUiArtifactTrustRootV1;
}>;

function hasRevocation(
    state: PluginUiArtifactRevocationState | undefined,
    predicate: (scope: PluginUiArtifactRevocationState['revocations'][number]['scope']) => boolean,
): boolean {
    return (state?.revocations ?? []).some((revocation) => predicate(revocation.scope));
}

export function createPluginUiArtifactSigningKeyPair(): PluginUiArtifactSigningKeyPair {
    const keyPair = tweetnacl.sign.keyPair();
    return Object.freeze({
        publicKey: keyPair.publicKey,
        secretKey: keyPair.secretKey,
    });
}

export function signPluginUiArtifactManifest(params: Readonly<{
    artifact: unknown;
    keyPair: PluginUiArtifactSigningKeyPair;
    keyId: string;
    trustRootId: string;
}>): SignPluginUiArtifactManifestResult {
    const keyId = params.keyId.trim();
    if (!keyId) {
        throw new Error('signPluginUiArtifactManifest requires a non-empty keyId');
    }
    const trustRootId = params.trustRootId.trim();
    if (!trustRootId) {
        throw new Error('signPluginUiArtifactManifest requires a non-empty trustRootId');
    }
    if (params.keyPair.secretKey.length !== tweetnacl.sign.secretKeyLength) {
        throw new Error(
            `signPluginUiArtifactManifest requires a ${tweetnacl.sign.secretKeyLength}-byte Ed25519 secret key`,
        );
    }
    if (params.keyPair.publicKey.length !== tweetnacl.sign.publicKeyLength) {
        throw new Error(
            `signPluginUiArtifactManifest requires a ${tweetnacl.sign.publicKeyLength}-byte Ed25519 public key`,
        );
    }

    const manifest = PluginUiExecutableArtifactManifestV1Schema.parse(params.artifact);
    if (!hasPluginUiExecutableArtifactIntegrityV1(manifest)) {
        throw new Error('signPluginUiArtifactManifest requires immutable artifact integrity');
    }
    const payload = createPluginUiArtifactSignaturePayloadV1(manifest);
    const signingInput = new TextEncoder().encode(
        createPluginUiArtifactSignatureSigningInputV1(payload),
    );
    const signatureBytes = tweetnacl.sign.detached(signingInput, params.keyPair.secretKey);
    const signature = encodeBase64(signatureBytes, 'base64url');

    const signedArtifact: PluginUiExecutableArtifactManifestWithIntegrityV1 = {
        ...manifest,
        integrity: {
            ...manifest.integrity,
            signature,
            signingKeyId: keyId,
        },
    };

    return Object.freeze({
        artifact: signedArtifact,
        signature: Object.freeze({
            t: 'happier.pluginUi.artifactSignature.v1',
            alg: 'ed25519',
            keyId,
            trustRootId,
            payload,
            signature,
        }),
        trustRoot: Object.freeze({
            id: trustRootId,
            keys: [Object.freeze({
                keyId,
                alg: 'ed25519',
                publicKeyBase64Url: encodeBase64(params.keyPair.publicKey, 'base64url'),
            })],
        }),
    });
}

export function resolvePluginUiArtifactVerifiedSignatureTrust(params: Readonly<{
    artifact: unknown;
    trustRoots: readonly PluginUiArtifactTrustRootV1[];
    revocationState?: PluginUiArtifactRevocationState;
}>): PluginUiArtifactTrustResolutionResult {
    const parsed = PluginUiExecutableArtifactManifestV1Schema.safeParse(params.artifact);
    if (!parsed.success) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }

    const artifact = parsed.data;
    if (!hasPluginUiExecutableArtifactIntegrityV1(artifact)) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }

    const signature = artifact.integrity.signature?.trim();
    if (!signature) {
        return Object.freeze({ ok: false, code: 'signature_required' });
    }

    const signingKeyId = artifact.integrity.signingKeyId?.trim();
    if (!signingKeyId) {
        return Object.freeze({ ok: false, code: 'signing_key_required' });
    }

    const trustRoot = params.trustRoots.find((candidate) =>
        candidate.keys.some((key) => key.keyId === signingKeyId && key.alg === 'ed25519'));
    if (!trustRoot) {
        return Object.freeze({ ok: false, code: 'trust_root_missing' });
    }

    if (hasRevocation(params.revocationState, (scope) =>
        scope.kind === 'trustRoot' && scope.trustRootId === trustRoot.id)) {
        return Object.freeze({ ok: false, code: 'trust_root_revoked' });
    }
    if (hasRevocation(params.revocationState, (scope) =>
        scope.kind === 'signingKey' && scope.signingKeyId === signingKeyId)) {
        return Object.freeze({ ok: false, code: 'signing_key_revoked' });
    }
    const revocationState = params.revocationState ?? createPluginUiArtifactRevocationState();
    if (isPluginUiArtifactRevoked({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        digest: artifact.integrity.digest,
        signingKeyId,
        ...(artifact.installSourceId ? { installSourceId: artifact.installSourceId } : {}),
    }, revocationState)) {
        return Object.freeze({ ok: false, code: 'artifact_revoked' });
    }

    const payload = createPluginUiArtifactSignaturePayloadV1(artifact);
    const verification = verifyPluginUiArtifactSignatureForArtifactV1({
        artifact,
        signature: {
            t: 'happier.pluginUi.artifactSignature.v1',
            alg: 'ed25519',
            keyId: signingKeyId,
            trustRootId: trustRoot.id,
            payload,
            signature,
        },
        trustRoots: [trustRoot],
    });
    if (!verification.valid) {
        return Object.freeze({
            ok: false,
            code: verification.reasonCode === 'payload_mismatch'
                ? 'signature_payload_mismatch'
                : 'signature_invalid',
        });
    }

    return Object.freeze({
        ok: true,
        executionTrust: Object.freeze({
            kind: 'verifiedSignature',
            signature,
            signingKeyId,
            trustRootId: trustRoot.id,
            canonicalPayload: createPluginUiArtifactSignatureSigningInputV1(payload),
        }),
    });
}

export function validatePluginUiArtifactExecutionTrust(params: Readonly<{
    artifact: PluginUiExecutableArtifactManifestWithIntegrityV1;
    executionTrust?: PluginUiArtifactExecutionTrust;
    signatureTrustRoots?: readonly PluginUiArtifactTrustRootV1[];
    revocationState: PluginUiArtifactRevocationState;
}>): PluginUiArtifactTrustValidationCode | null {
    const executionTrust = params.executionTrust;
    if (!executionTrust) {
        return 'execution_trust_unverified';
    }
    if (executionTrust.kind === 'trustedSource') {
        return null;
    }

    if (!params.artifact.integrity.signature) {
        return 'signature_required';
    }
    if (!params.artifact.integrity.signingKeyId) {
        return 'signing_key_required';
    }
    if (params.artifact.integrity.signingKeyId !== executionTrust.signingKeyId) {
        return 'signing_key_mismatch';
    }
    if (params.artifact.integrity.signature !== executionTrust.signature) {
        return 'signature_mismatch';
    }
    if (isPluginUiArtifactRevoked({
        pluginId: params.artifact.pluginId,
        contributionId: params.artifact.contributionId,
        digest: params.artifact.integrity.digest,
        signingKeyId: executionTrust.signingKeyId,
        trustRootId: executionTrust.trustRootId,
        ...(params.artifact.installSourceId ? { installSourceId: params.artifact.installSourceId } : {}),
    }, params.revocationState)) {
        return 'artifact_revoked';
    }
    if (!params.signatureTrustRoots?.length) {
        return 'signature_verification_unavailable';
    }

    const verification = verifyPluginUiArtifactSignatureForArtifactV1({
        artifact: params.artifact,
        signature: {
            t: 'happier.pluginUi.artifactSignature.v1',
            alg: 'ed25519',
            keyId: executionTrust.signingKeyId,
            trustRootId: executionTrust.trustRootId,
            payload: createPluginUiArtifactSignaturePayloadV1(params.artifact),
            signature: executionTrust.signature,
        },
        trustRoots: params.signatureTrustRoots,
    });
    if (!verification.valid) {
        return verification.reasonCode === 'trust_root_missing'
            ? 'signature_verification_unavailable'
            : 'signature_mismatch';
    }

    return null;
}

export function createPluginUiArtifactTrustDiagnostic(params: Readonly<{
    artifactKind: string;
    sourceKind?: string;
    trust: string;
}>): string {
    const artifactKind = params.artifactKind.trim() || 'unknownArtifact';
    const sourceKind = params.sourceKind?.trim() || 'unknown';
    const trust = params.trust.trim() || 'unknown';
    return `${artifactKind}:source=${sourceKind}:trust=${trust}`;
}
