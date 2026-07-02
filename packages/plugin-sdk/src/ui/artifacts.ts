import {
    PluginUiExecutableArtifactManifestV1Schema,
    derivePluginUiArtifactCacheKeyV1,
    type PluginUiExecutableArtifactManifestV1,
} from '@happier-dev/protocol';

export function defineUiArtifactManifest<const TArtifact extends PluginUiExecutableArtifactManifestV1>(
    artifact: TArtifact,
): TArtifact {
    return PluginUiExecutableArtifactManifestV1Schema.parse(artifact) as TArtifact;
}

export function deriveUiArtifactCacheKey(
    artifact: PluginUiExecutableArtifactManifestV1,
): string {
    return derivePluginUiArtifactCacheKeyV1(artifact);
}

export type {
    PluginUiExecutableArtifactManifestV1,
} from '@happier-dev/protocol';
