import { describe, expect, it } from 'vitest';

import { defineUiArtifactIntegrity } from './artifactIntegrity';

describe('plugin UI artifact integrity SDK helpers', () => {
    it('validates digest and binding metadata through the protocol integrity contract', () => {
        expect(defineUiArtifactIntegrity({
            digest: 'sha256:bundle',
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactKind: 'reactNativeBundle',
        })).toEqual({
            digest: 'sha256:bundle',
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactKind: 'reactNativeBundle',
        });

        expect(() => defineUiArtifactIntegrity({
            digest: 'bundle',
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactKind: 'reactNativeBundle',
        })).toThrow();
    });
});
