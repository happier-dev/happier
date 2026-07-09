import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import {
    createPluginUiArtifactSignaturePayloadV1,
    createPluginUiArtifactSignatureSigningInputV1,
    encodeBase64,
} from '@happier-dev/protocol';

import {
    resolvePluginUiArtifactVerifiedSignatureTrust,
} from './artifactSigning';
import { createPluginUiArtifactRevocationState } from './revocation';

const artifact = {
    id: 'native-preview-ios',
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    contributionFamily: 'reactNativeBundles',
    artifactKind: 'reactNativeBundle',
    platform: 'ios',
    channel: 'internal',
    integrity: {
        digest: `sha256:${'a'.repeat(64)}`,
        signingKeyId: 'rn-key-1',
    },
    compatibility: {
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
        nativeCapabilities: ['haptics', 'clipboard'],
    },
    byteSize: 1024,
    contentType: 'application/javascript',
    assetPath: 'react-native/native-preview/ios.bundle.js',
} as const;

function signedArtifact() {
    const keyPair = tweetnacl.sign.keyPair();
    const payload = createPluginUiArtifactSignaturePayloadV1(artifact);
    const signature = encodeBase64(
        tweetnacl.sign.detached(
            new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload)),
            keyPair.secretKey,
        ),
        'base64url',
    );

    return {
        artifact: {
            ...artifact,
            integrity: {
                ...artifact.integrity,
                signature,
            },
        },
        trustRoot: {
            id: 'happier-rn-root-v1',
            keys: [{
                keyId: 'rn-key-1',
                alg: 'ed25519' as const,
                publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
            }],
        },
    };
}

describe('plugin UI artifact trust roots', () => {
    it('fails closed for development devUrl artifacts without immutable integrity', () => {
        expect(resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: {
                ...artifact,
                channel: 'development',
                integrity: undefined,
                assetPath: undefined,
                devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
            },
            trustRoots: [],
            revocationState: createPluginUiArtifactRevocationState(),
        })).toEqual({ ok: false, code: 'invalid_manifest' });
    });

    it('resolves verifiedSignature trust only for a trusted root and valid signature', () => {
        const signed = signedArtifact();

        expect(resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: signed.artifact,
            trustRoots: [signed.trustRoot],
            revocationState: createPluginUiArtifactRevocationState(),
        })).toMatchObject({
            ok: true,
            executionTrust: {
                kind: 'verifiedSignature',
                signature: signed.artifact.integrity.signature,
                signingKeyId: 'rn-key-1',
                trustRootId: 'happier-rn-root-v1',
            },
        });
    });

    it('rejects matching signature strings without a trusted root or with payload mismatch', () => {
        const signed = signedArtifact();

        expect(resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: signed.artifact,
            trustRoots: [],
            revocationState: createPluginUiArtifactRevocationState(),
        })).toEqual({ ok: false, code: 'trust_root_missing' });

        expect(resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: {
                ...signed.artifact,
                integrity: {
                    ...signed.artifact.integrity,
                    digest: `sha256:${'b'.repeat(64)}`,
                },
            },
            trustRoots: [signed.trustRoot],
            revocationState: createPluginUiArtifactRevocationState(),
        })).toEqual({ ok: false, code: 'signature_invalid' });
    });

    it('fails closed for revoked roots, keys, and digests', () => {
        const signed = signedArtifact();

        expect(resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: signed.artifact,
            trustRoots: [signed.trustRoot],
            revocationState: createPluginUiArtifactRevocationState({
                revocations: [{
                    id: 'revoke-root',
                    scope: { kind: 'trustRoot', trustRootId: 'happier-rn-root-v1' },
                    reason: 'compromised',
                    revokedAt: '2026-06-20T00:00:00.000Z',
                }],
            }),
        })).toEqual({ ok: false, code: 'trust_root_revoked' });

        expect(resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: signed.artifact,
            trustRoots: [signed.trustRoot],
            revocationState: createPluginUiArtifactRevocationState({
                revocations: [{
                    id: 'revoke-key',
                    scope: { kind: 'signingKey', signingKeyId: 'rn-key-1' },
                    reason: 'compromised',
                    revokedAt: '2026-06-20T00:00:00.000Z',
                }],
            }),
        })).toEqual({ ok: false, code: 'signing_key_revoked' });

        expect(resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: signed.artifact,
            trustRoots: [signed.trustRoot],
            revocationState: createPluginUiArtifactRevocationState({
                revocations: [{
                    id: 'revoke-digest',
                    scope: { kind: 'digest', digest: signed.artifact.integrity.digest },
                    reason: 'compromised',
                    revokedAt: '2026-06-20T00:00:00.000Z',
                }],
            }),
        })).toEqual({ ok: false, code: 'artifact_revoked' });
    });
});
