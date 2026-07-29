import { describe, expect, it } from 'vitest';

import { defineUiArtifactManifest, deriveUiArtifactCacheKey } from './artifacts';

describe('plugin UI artifact SDK helpers', () => {
    it('defines executable UI artifact manifests with digest-bound cache keys', () => {
        const artifact = defineUiArtifactManifest({
            id: 'native-preview-ios',
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            contributionFamily: 'reactNativeBundles',
            artifactKind: 'reactNativeBundle',
            platform: 'ios',
            channel: 'internal',
            integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
            compatibility: {
                hostAppVersion: '2.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                reactNativeVersion: '0.79.0',
                nativeCapabilities: [],
            },
            byteSize: 1024,
            contentType: 'application/javascript',
            assetPath: 'ui/native/ios.bundle',
        });

        expect(deriveUiArtifactCacheKey(artifact)).toContain('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    });
});
