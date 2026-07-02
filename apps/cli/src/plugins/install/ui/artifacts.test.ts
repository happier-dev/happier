import { describe, expect, it } from 'vitest';

import { validateInstalledPluginUiArtifactManifest } from './artifacts';

const artifact = {
    id: 'native-preview-ios',
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    contributionFamily: 'reactNativeBundles',
    artifactKind: 'reactNativeBundle',
    platform: 'ios',
    channel: 'internal',
    integrity: { digest: 'sha256:bundle' },
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
            cacheKey: expect.stringContaining('sha256:bundle'),
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
            revokedDigests: new Set(['sha256:bundle']),
        })).toEqual({ ok: false, code: 'artifact_revoked' });
    });
});
