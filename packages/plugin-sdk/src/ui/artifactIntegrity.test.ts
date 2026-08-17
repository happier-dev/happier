import { describe, expect, it } from 'vitest';

import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol/plugins/ui';

import { defineUiArtifactIntegrity } from './artifactIntegrity';

const digest = (character: string) => PluginUiArtifactDigestV1Schema.parse(
    `sha256:${character.repeat(64)}`,
);

describe('plugin UI artifact integrity SDK helpers', () => {
    it('validates digest and binding metadata through the protocol integrity contract', () => {
        expect(defineUiArtifactIntegrity({
            digest: digest('b'),
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactKind: 'reactNativeBundle',
        })).toEqual({
            digest: digest('b'),
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactKind: 'reactNativeBundle',
        });

        expect(() => PluginUiArtifactDigestV1Schema.parse('bundle')).toThrow();
    });
});
