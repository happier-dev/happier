import { PluginHostedWebRuntimeModeV1Schema, PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginHostedWebRuntimeModeV1, PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';

export function defineHostedWebRuntimeMode<const TRuntimeMode extends PluginHostedWebRuntimeModeV1>(
    runtimeMode: TRuntimeMode,
): TRuntimeMode {
    return PluginHostedWebRuntimeModeV1Schema.parse(runtimeMode) as TRuntimeMode;
}

export function defineUiArtifactsManifest<const TManifest extends PluginUiArtifactsManifestV2>(
    manifest: TManifest,
): TManifest {
    return PluginUiArtifactsManifestV2Schema.parse(manifest) as TManifest;
}

export type {
    PluginHostedWebRuntimeModeV1,
    PluginUiArtifactsManifestV2,
} from '@happier-dev/protocol/plugins/ui';
