import { describe, expect, it } from 'vitest';

import type { PluginUiArtifactProjection, PluginUiProjectionModel } from './projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import { resolvePluginUiArtifactInvalidation } from './artifactInvalidation';

function artifact(params: Readonly<{
    id: string;
    pluginId: string;
    artifactId: string;
    digest: string;
    revokedAt?: string;
}>): PluginUiArtifactProjection {
    return Object.freeze({
        id: params.id,
        pluginId: params.pluginId,
        contributionKind: 'uiArtifact',
        artifactId: params.artifactId,
        integrity: { digest: params.digest },
        ...(params.revokedAt ? { revokedAt: params.revokedAt } : {}),
    });
}

function model(artifacts: readonly PluginUiArtifactProjection[]): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 1,
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
            changedArtifactIds: ['uiArtifact:acme.preview:native-ios'],
            changedPluginIds: ['acme.preview'],
            removedArtifactIds: [],
            revokedArtifactIds: [],
        });
    });

    it('reports removed and revoked artifacts without blanking unrelated plugins', () => {
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
                revokedAt: '2026-06-09T19:00:00.000Z',
            }),
        ]);

        expect(resolvePluginUiArtifactInvalidation(previous, next)).toEqual({
            changedArtifactIds: ['uiArtifact:acme.preview:native-ios'],
            changedPluginIds: ['acme.preview', 'gone.preview'],
            removedArtifactIds: ['uiArtifact:gone.preview:native-ios'],
            revokedArtifactIds: ['uiArtifact:acme.preview:native-ios'],
        });
    });
});
