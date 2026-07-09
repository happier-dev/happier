import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
    createPluginUiArtifactSignaturePayloadV1,
    createPluginUiArtifactSignatureSigningInputV1,
    encodeBase64,
} from '@happier-dev/protocol';

import { createPluginUiArtifactRevocationState } from './revocation';
import { validateInstalledEmbeddedWebBundleArtifact } from './embeddedWebBundles';

const hostRuntime = {
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    platform: 'web',
    channel: 'internal',
    projectionGeneration: 12,
} as const;

const artifact = {
    id: 'embedded-preview-web',
    pluginId: 'acme.preview',
    contributionId: 'embedded-preview',
    contributionFamily: 'embeddedWebBundles',
    artifactKind: 'embeddedWebBundle',
    platform: 'web',
    channel: 'internal',
    integrity: { digest: `sha256:${'e'.repeat(64)}` },
    compatibility: {
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        supportedChannels: ['internal'],
        nativeCapabilities: [],
    },
    byteSize: 2048,
    contentType: 'text/javascript',
    assetPath: 'embedded-web/embedded-preview/entry.mjs',
} as const;

function signArtifact(input: typeof artifact) {
    const keyPair = tweetnacl.sign.keyPair();
    const payload = createPluginUiArtifactSignaturePayloadV1({
        ...input,
        integrity: {
            ...input.integrity,
            signingKeyId: 'embedded-key-1',
        },
    });
    const signature = encodeBase64(
        tweetnacl.sign.detached(
            new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload)),
            keyPair.secretKey,
        ),
        'base64url',
    );
    const signedArtifact = {
        ...input,
        integrity: {
            ...input.integrity,
            signature,
            signingKeyId: 'embedded-key-1',
        },
    };
    return {
        artifact: signedArtifact,
        signature,
        trustRoot: {
            id: 'happier-embedded-root-v1',
            keys: [{
                keyId: 'embedded-key-1',
                alg: 'ed25519' as const,
                publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
            }],
        },
    };
}

describe('embedded-web bundle install validation', () => {
    it('rejects unsigned executable JavaScript artifacts from non-local sources', () => {
        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime,
            revokedDigests: new Set(),
        })).toEqual({
            ok: false,
            code: 'execution_trust_unverified',
            diagnostics: ['embeddedWebBundle:source=unknown:trust=unverified'],
        });
    });

    it('allows local_trusted embedded-web artifacts without a signature', () => {
        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'trustedSource',
                reason: 'local_trusted',
                sourceKind: 'path',
            },
        })).toMatchObject({ ok: true });
    });

    it('uses supportedChannels as the channel authority instead of the artifact provenance channel', () => {
        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact: {
                ...artifact,
                compatibility: {
                    ...artifact.compatibility,
                    supportedChannels: ['internal', 'development'],
                },
            },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime: { ...hostRuntime, channel: 'development' },
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'trustedSource',
                reason: 'local_trusted',
                sourceKind: 'path',
            },
        })).toMatchObject({ ok: true, cacheIdentity: { channel: 'internal' } });

        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime: { ...hostRuntime, channel: 'development' },
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'trustedSource',
                reason: 'local_trusted',
                sourceKind: 'path',
            },
        })).toEqual({ ok: false, code: 'channel_unsupported' });
    });

    it('accepts signed embedded-web artifacts after Ed25519 verification against a trusted root', () => {
        const signed = signArtifact(artifact);

        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact: signed.artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime,
            revokedDigests: new Set(),
            revocationState: createPluginUiArtifactRevocationState(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: signed.signature,
                signingKeyId: 'embedded-key-1',
                trustRootId: 'happier-embedded-root-v1',
            },
            signatureTrustRoots: [signed.trustRoot],
        })).toMatchObject({ ok: true });
    });

    it('rejects invalid signatures for non-local embedded-web artifacts', () => {
        const signed = signArtifact(artifact);
        const tamperedSignature = `${signed.signature[0] === 'A' ? 'B' : 'A'}${signed.signature.slice(1)}`;

        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact: {
                ...signed.artifact,
                integrity: {
                    ...signed.artifact.integrity,
                    signature: tamperedSignature,
                },
            },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: tamperedSignature,
                signingKeyId: 'embedded-key-1',
                trustRootId: 'happier-embedded-root-v1',
            },
            signatureTrustRoots: [signed.trustRoot],
        })).toEqual({
            ok: false,
            code: 'signature_mismatch',
            diagnostics: ['embeddedWebBundle:source=unknown:trust=signature_mismatch'],
        });
    });

    it('rejects signed artifacts when manifest and execution-trust signing keys disagree', () => {
        const signed = signArtifact(artifact);

        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact: {
                ...signed.artifact,
                integrity: {
                    ...signed.artifact.integrity,
                    signingKeyId: 'other-key',
                },
            },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: signed.signature,
                signingKeyId: 'embedded-key-1',
                trustRootId: 'happier-embedded-root-v1',
            },
            signatureTrustRoots: [signed.trustRoot],
        })).toEqual({
            ok: false,
            code: 'signing_key_mismatch',
            diagnostics: ['embeddedWebBundle:source=unknown:trust=signing_key_mismatch'],
        });
    });

    it('rejects signed artifacts when manifest and execution-trust signatures disagree', () => {
        const signed = signArtifact(artifact);
        const manifestSignature = `${signed.signature[0] === 'A' ? 'B' : 'A'}${signed.signature.slice(1)}`;

        expect(validateInstalledEmbeddedWebBundleArtifact({
            artifact: {
                ...signed.artifact,
                integrity: {
                    ...signed.artifact.integrity,
                    signature: manifestSignature,
                },
            },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'embedded-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: signed.signature,
                signingKeyId: 'embedded-key-1',
                trustRootId: 'happier-embedded-root-v1',
            },
            signatureTrustRoots: [signed.trustRoot],
        })).toEqual({
            ok: false,
            code: 'signature_mismatch',
            diagnostics: ['embeddedWebBundle:source=unknown:trust=signature_mismatch'],
        });
    });
});
