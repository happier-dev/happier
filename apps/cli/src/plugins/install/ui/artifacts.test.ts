import { describe, expect, it } from 'vitest';

import { validateInstalledPluginUiArtifactManifest } from './artifacts';
import { createPluginUiArtifactRevocationState } from './revocation';

const artifact = {
    id: 'native-preview-ios',
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    contributionFamily: 'reactNativeBundles',
    artifactKind: 'reactNativeBundle',
    platform: 'ios',
    channel: 'internal',
    integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    compatibility: {
        hostAppVersion: '1.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.79.0',
    },
    byteSize: 1024,
    contentType: 'application/javascript',
    assetPath: 'ui/native/ios.bundle',
} as const;

describe('plugin UI artifact install validation', () => {
    it('accepts digest-bound artifacts for the expected plugin and contribution', () => {
        expect(validateInstalledPluginUiArtifactManifest({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            revokedDigests: new Set(),
        })).toMatchObject({
            ok: true,
            cacheKey: expect.stringContaining('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        });
    });

    it('fails closed when artifact binding or revocation state does not match', () => {
        expect(validateInstalledPluginUiArtifactManifest({
            artifact,
            expectedPluginId: 'other.plugin',
            expectedContributionId: 'native-preview',
            revokedDigests: new Set(),
        })).toEqual({ ok: false, code: 'plugin_id_mismatch' });

        expect(validateInstalledPluginUiArtifactManifest({
            artifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            revokedDigests: new Set(['sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']),
        })).toEqual({ ok: false, code: 'artifact_revoked' });
    });

    it('rejects signing-key and install-source scoped revocations when full revocation state is supplied', () => {
        const revocableArtifact = {
            ...artifact,
            integrity: {
                ...artifact.integrity,
                signingKeyId: 'rn-key-1',
            },
            installSourceId: 'marketplace:acme',
        };

        const signingKeyValidationInput = {
            artifact: revocableArtifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            revokedDigests: new Set<string>(),
            revocationState: createPluginUiArtifactRevocationState({
                revocations: [{
                    id: 'revoke-signing-key',
                    scope: { kind: 'signingKey', signingKeyId: 'rn-key-1' },
                    reason: 'compromised',
                    revokedAt: '2026-06-20T00:00:00.000Z',
                }],
            }),
        };
        expect(validateInstalledPluginUiArtifactManifest(signingKeyValidationInput)).toEqual({
            ok: false,
            code: 'artifact_revoked',
        });

        const installSourceValidationInput = {
            artifact: revocableArtifact,
            expectedPluginId: 'acme.preview',
            expectedContributionId: 'native-preview',
            revokedDigests: new Set<string>(),
            revocationState: createPluginUiArtifactRevocationState({
                revocations: [{
                    id: 'revoke-install-source',
                    scope: { kind: 'installSource', sourceId: 'marketplace:acme' },
                    reason: 'policy_denied',
                    revokedAt: '2026-06-21T00:00:00.000Z',
                }],
            }),
        };
        expect(validateInstalledPluginUiArtifactManifest(installSourceValidationInput)).toEqual({
            ok: false,
            code: 'artifact_revoked',
        });
    });
});
