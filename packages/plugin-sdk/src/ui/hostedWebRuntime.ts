import {
    PluginHostedWebRuntimeModeV1Schema,
    PluginUiArtifactsManifestV1Schema,
    type PluginHostedWebRuntimeModeV1,
    type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

export function defineHostedWebRuntimeMode<const TRuntimeMode extends PluginHostedWebRuntimeModeV1>(
    runtimeMode: TRuntimeMode,
): TRuntimeMode {
    return PluginHostedWebRuntimeModeV1Schema.parse(runtimeMode) as TRuntimeMode;
}

export function defineUiArtifactsManifest<const TManifest extends PluginUiArtifactsManifestV1>(
    manifest: TManifest,
): TManifest {
    return PluginUiArtifactsManifestV1Schema.parse(manifest) as TManifest;
}

export type {
    PluginHostedWebRuntimeModeV1,
    PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';
