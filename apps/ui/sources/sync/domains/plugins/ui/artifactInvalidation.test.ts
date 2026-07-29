import { describe, expect, it } from 'vitest';

import type { PluginUiArtifactProjection, PluginUiProjectionModel } from './projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import { resolvePluginUiArtifactInvalidation } from './artifactInvalidation';

function artifact(params: Readonly<{
    id: string;
    pluginId: string;
    artifactId: string;
    digest: string;
}>): PluginUiArtifactProjection {
    return Object.freeze({
        id: params.id,
        pluginId: params.pluginId,
        contributionKind: 'uiArtifact',
        artifactId: params.artifactId,
        integrity: { digest: params.digest },
    });
}

function model(artifacts: readonly PluginUiArtifactProjection[], generation = 1): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation,
        uiArtifactsById: Object.freeze(Object.fromEntries(artifacts.map((entry) => [entry.id, entry]))),
    });
}

describe('plugin UI artifact invalidation', () => {
    it('invalidates only the plugin whose artifact changed', () => {
        const previous = model([
            artifact({
                id: 'uiArtifact:acme.preview:native-ios',
                pluginId: 'acme.preview',
                artifactId: 'native-ios',
                digest: 'sha256:old',
            }),
            artifact({
                id: 'uiArtifact:other.preview:native-ios',
                pluginId: 'other.preview',
                artifactId: 'native-ios',
                digest: 'sha256:stable',
            }),
        ]);
        const next = model([
            artifact({
                id: 'uiArtifact:acme.preview:native-ios',
                pluginId: 'acme.preview',
                artifactId: 'native-ios',
                digest: 'sha256:new',
            }),
            artifact({
                id: 'uiArtifact:other.preview:native-ios',
                pluginId: 'other.preview',
                artifactId: 'native-ios',
                digest: 'sha256:stable',
            }),
        ]);

        expect(resolvePluginUiArtifactInvalidation(previous, next)).toEqual({
            projectionGenerationChanged: false,
            changedArtifactIds: ['uiArtifact:acme.preview:native-ios'],
            changedPluginIds: ['acme.preview'],
            removedArtifactIds: [],
        });
    });

    it('reports removed artifacts without blanking unrelated plugins', () => {
        const previous = model([
            artifact({
                id: 'uiArtifact:acme.preview:native-ios',
                pluginId: 'acme.preview',
                artifactId: 'native-ios',
                digest: 'sha256:old',
            }),
            artifact({
                id: 'uiArtifact:gone.preview:native-ios',
                pluginId: 'gone.preview',
                artifactId: 'native-ios',
                digest: 'sha256:gone',
            }),
        ]);
        const next = model([
            artifact({
                id: 'uiArtifact:acme.preview:native-ios',
                pluginId: 'acme.preview',
                artifactId: 'native-ios',
                digest: 'sha256:old',
            }),
        ]);

        expect(resolvePluginUiArtifactInvalidation(previous, next)).toEqual({
            projectionGenerationChanged: false,
            changedArtifactIds: [],
            changedPluginIds: ['gone.preview'],
            removedArtifactIds: ['uiArtifact:gone.preview:native-ios'],
        });
    });

    it('marks every executable artifact owner stale when the projection generation is replaced', () => {
        const stableArtifact = artifact({
            id: 'uiArtifact:acme.preview:native-web',
            pluginId: 'acme.preview',
            artifactId: 'native-web',
            digest: 'sha256:stable',
        });

        expect(resolvePluginUiArtifactInvalidation(
            model([stableArtifact], 12),
            model([stableArtifact], 13),
        )).toEqual({
            changedArtifactIds: [],
            changedPluginIds: ['acme.preview'],
            projectionGenerationChanged: true,
            removedArtifactIds: [],
        });
    });
});
