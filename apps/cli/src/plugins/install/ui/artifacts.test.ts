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
        })).toMatchObject({
            ok: true,
            cacheKey: expect.stringContaining('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        });
    });

    it('fails closed when the artifact binding does not match', () => {
        expect(validateInstalledPluginUiArtifactManifest({
            artifact,
            expectedPluginId: 'other.plugin',
            expectedContributionId: 'native-preview',
        })).toEqual({ ok: false, code: 'plugin_id_mismatch' });
    });
});
