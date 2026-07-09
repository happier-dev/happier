import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import type { PluginUiArtifactRevocationV1 } from '@happier-dev/protocol';
import {
    createPluginUiArtifactSignaturePayloadV1,
    createPluginUiArtifactSignatureSigningInputV1,
    encodeBase64,
} from '@happier-dev/protocol';

import {
    classifyReactNativeBundleArtifactSource,
    deriveReactNativeNativeCapabilitiesDigest,
    validateInstalledReactNativeBundleArtifact,
} from './reactNativeBundles';
import { createPluginUiArtifactRevocationState } from './revocation';
import { resolvePluginUiArtifactVerifiedSignatureTrust } from './artifactSigning';

const hostRuntime = {
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    expoRuntimeVersion: '0.2.0-native',
    hermesVersion: '0.15.0',
    platform: 'ios',
    channel: 'internal',
    availableNativeCapabilities: ['clipboard', 'haptics'],
    projectionGeneration: 12,
} as const;
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`;

const artifact = {
    id: 'native-preview-ios',
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    contributionFamily: 'reactNativeBundles',
    artifactKind: 'reactNativeBundle',
    platform: 'ios',
    channel: 'internal',
    integrity: { digest: ARTIFACT_DIGEST },
    compatibility: {
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
        // RN-HARDEN item 2: supportedChannels is the channel-gate authority; the
        // provenance `channel` field above is metadata only. Non-first-party
        // artifacts without this declaration fail closed (`channel_unsupported`).
        supportedChannels: ['internal'],
        nativeCapabilities: ['haptics', 'clipboard'],
    },
    byteSize: 1024,
    contentType: 'application/javascript',
    assetPath: 'react-native/native-preview/ios.bundle.js',
} as const;

// The pre-declaration shape (no supportedChannels) for the fail-closed matrix rows.
const { supportedChannels: _baseSupportedChannels, ...artifactCompatibilityWithoutChannels } = artifact.compatibility;
void _baseSupportedChannels;
const undeclaredChannelsArtifact = {
    ...artifact,
    compatibility: artifactCompatibilityWithoutChannels,
} as const;

describe('React Native bundle install validation', () => {
    it('accepts installed plain-JS artifacts and derives the full runtime cache identity', () => {
        const result = validateInstalledReactNativeBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        });

        expect(result).toMatchObject({
            ok: true,
            cacheIdentity: {
                pluginId: 'acme.preview',
                contributionId: 'native-preview',
                artifactDigest: ARTIFACT_DIGEST,
                hostAppVersion: '2.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
                expoRuntimeVersion: '0.2.0-native',
                hermesVersion: '0.15.0',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest(['clipboard', 'haptics']),
                projectionGeneration: 12,
            },
        });
        expect(result.ok && result.cacheKey).toContain('2.0.0');
    });

    it('accepts a platform:web installed artifact through the same signing/trust/revocation pipeline (LEDGER DEC-6 RN-web)', () => {
        const webHostRuntime = {
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            platform: 'web',
            channel: 'internal',
            availableNativeCapabilities: [],
            projectionGeneration: 12,
        } as const;
        const webArtifact = {
            id: 'native-preview-web',
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            contributionFamily: 'reactNativeBundles',
            artifactKind: 'reactNativeBundle',
            platform: 'web',
            channel: 'internal',
            integrity: { digest: ARTIFACT_DIGEST },
            compatibility: {
                hostAppVersion: '2.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
                supportedChannels: ['internal'],
                nativeCapabilities: [],
            },
            byteSize: 1024,
            contentType: 'application/javascript',
            assetPath: 'react-native-web/native-preview/entry.mjs',
        } as const;

        const result = validateInstalledReactNativeBundleArtifact({
            artifact: webArtifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime: webHostRuntime,
            revokedDigests: new Set(),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        });

        expect(result).toMatchObject({
            ok: true,
            cacheIdentity: { platform: 'web', artifactDigest: ARTIFACT_DIGEST },
        });
    });

    it('fails closed for installed artifacts until executable trust is proven', () => {
        expect(validateInstalledReactNativeBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
        })).toEqual({ ok: false, code: 'execution_trust_unverified' });
    });

    it('does not accept matching signature strings as cryptographic proof', () => {
        const signedArtifact = {
            ...artifact,
            integrity: {
                ...artifact.integrity,
                signature: 'sig.rn.bundle',
                signingKeyId: 'rn-key-1',
            },
        };

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: signedArtifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: 'sig.rn.bundle',
                signingKeyId: 'rn-key-1',
                trustRootId: 'happier-rn-root-v1',
            },
        })).toEqual({ ok: false, code: 'signature_verification_unavailable' });
    });

    it('rejects forged verifiedSignature trust with a caller-computed canonical payload', () => {
        const signedArtifact = {
            ...artifact,
            integrity: {
                digest: `sha256:${'a'.repeat(64)}`,
                signature: 'sig.rn.bundle',
                signingKeyId: 'rn-key-1',
            },
        };
        const canonicalPayload = createPluginUiArtifactSignatureSigningInputV1(
            createPluginUiArtifactSignaturePayloadV1(signedArtifact),
        );

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: signedArtifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: 'sig.rn.bundle',
                signingKeyId: 'rn-key-1',
                trustRootId: 'happier-rn-root-v1',
                canonicalPayload,
            },
        })).toEqual({ ok: false, code: 'signature_verification_unavailable' });
    });

    it('rejects verifiedSignature trust when its trust root is revoked', () => {
        const signedArtifact = {
            ...artifact,
            integrity: {
                digest: `sha256:${'a'.repeat(64)}`,
                signature: 'sig.rn.bundle',
                signingKeyId: 'rn-key-1',
            },
        };
        const canonicalPayload = createPluginUiArtifactSignatureSigningInputV1(
            createPluginUiArtifactSignaturePayloadV1(signedArtifact),
        );

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: signedArtifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            revocationState: createPluginUiArtifactRevocationState({
                revocations: [{
                    id: 'revoke-root',
                    scope: { kind: 'trustRoot', trustRootId: 'happier-rn-root-v1' },
                    reason: 'compromised',
                    revokedAt: '2026-06-20T00:00:00.000Z',
                }],
            }),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: 'sig.rn.bundle',
                signingKeyId: 'rn-key-1',
                trustRootId: 'happier-rn-root-v1',
                canonicalPayload,
            },
        })).toEqual({ ok: false, code: 'artifact_revoked' });
    });

    it('accepts verifiedSignature only after protocol verification against a trusted root', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const signedArtifact = {
            ...artifact,
            integrity: {
                ...artifact.integrity,
                digest: `sha256:${'a'.repeat(64)}`,
                signingKeyId: 'rn-key-1',
            },
        };
        const payload = createPluginUiArtifactSignaturePayloadV1(signedArtifact);
        const signature = encodeBase64(
            tweetnacl.sign.detached(
                new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload)),
                keyPair.secretKey,
            ),
            'base64url',
        );
        const artifactWithSignature = {
            ...signedArtifact,
            integrity: {
                ...signedArtifact.integrity,
                signature,
            },
        };
        const trustRoot = {
            id: 'happier-rn-root-v1',
            keys: [{
                keyId: 'rn-key-1',
                alg: 'ed25519' as const,
                publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
            }],
        };
        const trust = resolvePluginUiArtifactVerifiedSignatureTrust({
            artifact: artifactWithSignature,
            trustRoots: [trustRoot],
            revocationState: createPluginUiArtifactRevocationState(),
        });

        expect(trust).toMatchObject({ ok: true });
        expect(validateInstalledReactNativeBundleArtifact({
            artifact: artifactWithSignature,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: trust.ok ? trust.executionTrust : undefined,
            signatureTrustRoots: [trustRoot],
        })).toMatchObject({ ok: true });
    });

    it('rejects a tampered signature via the authoritative Ed25519 verify (not a string pre-check)', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const signedArtifact = {
            ...artifact,
            integrity: {
                ...artifact.integrity,
                digest: `sha256:${'a'.repeat(64)}`,
                signingKeyId: 'rn-key-1',
            },
        };
        const payload = createPluginUiArtifactSignaturePayloadV1(signedArtifact);
        const signature = encodeBase64(
            tweetnacl.sign.detached(
                new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload)),
                keyPair.secretKey,
            ),
            'base64url',
        );
        const trustRoot = {
            id: 'happier-rn-root-v1',
            keys: [{
                keyId: 'rn-key-1',
                alg: 'ed25519' as const,
                publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
            }],
        };
        // The manifest signature does not match what the trusted key signed:
        // the only authority that can reject this is the host-derived Ed25519
        // verify, since the manifest signature and the executionTrust signature
        // are identical (so a string pre-check would have passed it through).
        const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
        const artifactWithTamperedSignature = {
            ...signedArtifact,
            integrity: {
                ...signedArtifact.integrity,
                signature: tamperedSignature,
            },
        };

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: artifactWithTamperedSignature,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature: tamperedSignature,
                signingKeyId: 'rn-key-1',
                trustRootId: 'happier-rn-root-v1',
            },
            signatureTrustRoots: [trustRoot],
        })).toEqual({ ok: false, code: 'signature_mismatch' });
    });

    it('rejects a wrong signing key via the authoritative Ed25519 verify', () => {
        const trustedKeyPair = tweetnacl.sign.keyPair();
        const attackerKeyPair = tweetnacl.sign.keyPair();
        const signedArtifact = {
            ...artifact,
            integrity: {
                ...artifact.integrity,
                digest: `sha256:${'b'.repeat(64)}`,
                signingKeyId: 'rn-key-1',
            },
        };
        const payload = createPluginUiArtifactSignaturePayloadV1(signedArtifact);
        // Signed by the attacker key, but presented under the trusted keyId.
        const signature = encodeBase64(
            tweetnacl.sign.detached(
                new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload)),
                attackerKeyPair.secretKey,
            ),
            'base64url',
        );
        const trustRoot = {
            id: 'happier-rn-root-v1',
            keys: [{
                keyId: 'rn-key-1',
                alg: 'ed25519' as const,
                publicKeyBase64Url: encodeBase64(trustedKeyPair.publicKey, 'base64url'),
            }],
        };
        const artifactWithSignature = {
            ...signedArtifact,
            integrity: {
                ...signedArtifact.integrity,
                signature,
            },
        };

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: artifactWithSignature,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: {
                kind: 'verifiedSignature',
                signature,
                signingKeyId: 'rn-key-1',
                trustRootId: 'happier-rn-root-v1',
            },
            signatureTrustRoots: [trustRoot],
        })).toEqual({ ok: false, code: 'signature_mismatch' });
    });

    it('fails closed for remote URLs, Hermes bytecode, revocation, runtime mismatch, and missing native capability', () => {
        expect(validateInstalledReactNativeBundleArtifact({
            artifact: { ...artifact, assetPath: undefined, url: 'https://example.test/native.bundle.js' },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        })).toEqual({ ok: false, code: 'remote_url_unsupported' });

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: {
                ...artifact,
                integrity: undefined,
                channel: 'development',
                assetPath: undefined,
                devUrl: 'http://127.0.0.1:8082/native.bundle.js',
            },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime: { ...hostRuntime, channel: 'development' },
            revokedDigests: new Set(),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        })).toEqual({ ok: false, code: 'dev_hot_reload_not_installable' });

        expect(validateInstalledReactNativeBundleArtifact({
            artifact: { ...artifact, contentType: 'application/x-hermes-bytecode', assetPath: 'react-native/native-preview/ios.hbc' },
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set(),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        })).toEqual({ ok: false, code: 'hermes_bytecode_unsupported' });

        expect(validateInstalledReactNativeBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime,
            revokedDigests: new Set([ARTIFACT_DIGEST]),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        })).toEqual({ ok: false, code: 'artifact_revoked' });

        expect(validateInstalledReactNativeBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime: { ...hostRuntime, reactNativeVersion: '0.82.0' },
            revokedDigests: new Set(),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        })).toEqual({ ok: false, code: 'runtime_mismatch' });

        expect(validateInstalledReactNativeBundleArtifact({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            hostRuntime: { ...hostRuntime, availableNativeCapabilities: ['clipboard'] },
            revokedDigests: new Set(),
            executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
        })).toEqual({ ok: false, code: 'missing_native_capability' });
    });

    describe('channel compat gate — supportedChannels is the single authority (RN-HARDEN item 2)', () => {
        const declaredArtifact = {
            ...artifact,
            compatibility: {
                ...artifact.compatibility,
                supportedChannels: ['internal', 'development'],
            },
        } as const;

        it('accepts a development-channel client when the artifact declares development in supportedChannels (channel stays provenance metadata)', () => {
            expect(validateInstalledReactNativeBundleArtifact({
                artifact: declaredArtifact,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'native-preview',
                hostRuntime: { ...hostRuntime, channel: 'development' },
                revokedDigests: new Set(),
                executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
            })).toMatchObject({ ok: true, cacheIdentity: { channel: 'internal' } });
        });

        it('rejects a client channel outside the declared supportedChannels', () => {
            expect(validateInstalledReactNativeBundleArtifact({
                artifact: {
                    ...artifact,
                    compatibility: { ...artifact.compatibility, supportedChannels: ['internal'] },
                },
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'native-preview',
                hostRuntime: { ...hostRuntime, channel: 'development' },
                revokedDigests: new Set(),
                executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
            })).toEqual({ ok: false, code: 'channel_unsupported' });
        });

        it('fails closed when supportedChannels is absent for a non-first-party artifact, even on a matching provenance channel', () => {
            expect(validateInstalledReactNativeBundleArtifact({
                artifact: undeclaredChannelsArtifact,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'native-preview',
                hostRuntime,
                revokedDigests: new Set(),
                executionTrust: { kind: 'trustedSource', reason: 'local_trusted' },
            })).toEqual({ ok: false, code: 'channel_unsupported' });
        });

        it('falls back to provenance-channel equality only for first-party artifacts predating the declaration', () => {
            expect(validateInstalledReactNativeBundleArtifact({
                artifact: undeclaredChannelsArtifact,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'native-preview',
                hostRuntime,
                revokedDigests: new Set(),
                executionTrust: { kind: 'trustedSource', reason: 'first_party' },
            })).toMatchObject({ ok: true });

            expect(validateInstalledReactNativeBundleArtifact({
                artifact: undeclaredChannelsArtifact,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'native-preview',
                hostRuntime: { ...hostRuntime, channel: 'development' },
                revokedDigests: new Set(),
                executionTrust: { kind: 'trustedSource', reason: 'first_party' },
            })).toEqual({ ok: false, code: 'channel_unsupported' });
        });
    });

    it('classifies dev hot reload as local development only and never as installed loading', () => {
        expect(classifyReactNativeBundleArtifactSource({
            ...artifact,
            channel: 'development',
            devUrl: 'http://127.0.0.1:8082/native.bundle.js',
        })).toEqual({ kind: 'devHotReload' });

        expect(classifyReactNativeBundleArtifactSource({
            ...artifact,
            url: 'https://example.test/native.bundle.js',
            assetPath: undefined,
        })).toEqual({ kind: 'remoteUnsupported' });

        expect(classifyReactNativeBundleArtifactSource(artifact)).toEqual({ kind: 'installedArtifact' });
    });

    it('rejects plugin, contribution, signing-key, and install-source revocation scopes', () => {
        function expectRevokedBy(
            revocation: PluginUiArtifactRevocationV1,
            artifactOverride: Readonly<Record<string, unknown>> = {},
        ): void {
            const params = {
                artifact: { ...artifact, ...artifactOverride },
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'native-preview',
                hostRuntime,
                revokedDigests: new Set<string>(),
                revocationState: createPluginUiArtifactRevocationState({
                    revocations: [revocation],
                }),
                executionTrust: { kind: 'trustedSource', reason: 'local_trusted' } as const,
            };

            expect(validateInstalledReactNativeBundleArtifact(params)).toEqual({
                ok: false,
                code: 'artifact_revoked',
            });
        }

        expectRevokedBy({
            id: 'revoke-plugin',
            scope: { kind: 'plugin', pluginId: 'acme.preview' },
            reason: 'policy_denied',
            revokedAt: '2026-06-15T00:00:00.000Z',
        });
        expectRevokedBy({
            id: 'revoke-contribution',
            scope: { kind: 'contribution', pluginId: 'acme.preview', contributionId: 'native-preview' },
            reason: 'compromised',
            revokedAt: '2026-06-15T00:00:00.000Z',
        });
        expectRevokedBy(
            {
                id: 'revoke-key',
                scope: { kind: 'signingKey', signingKeyId: 'rn-key-1' },
                reason: 'compromised',
                revokedAt: '2026-06-15T00:00:00.000Z',
            },
            { integrity: { ...artifact.integrity, signingKeyId: 'rn-key-1' } },
        );
        expectRevokedBy(
            {
                id: 'revoke-source',
                scope: { kind: 'installSource', sourceId: 'marketplace:acme' },
                reason: 'policy_denied',
                revokedAt: '2026-06-15T00:00:00.000Z',
            },
            { installSourceId: 'marketplace:acme' },
        );
    });
});
