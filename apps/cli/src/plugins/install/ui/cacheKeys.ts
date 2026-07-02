import {
    derivePluginUiArtifactCacheKeyV1,
    type PluginUiExecutableArtifactManifestV1,
} from '@happier-dev/protocol';

export function deriveInstalledPluginUiArtifactCacheKey(
    artifact: PluginUiExecutableArtifactManifestV1,
): string {
    return derivePluginUiArtifactCacheKeyV1(artifact);
}
