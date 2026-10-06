import { isPluginUiHostApiVersionCompatibleWithVersionV1 } from '@happier-dev/protocol/plugins/ui/hostApi';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui/hostApiDefinition';
import type { PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui';

export const PLUGIN_UI_HOST_API_VERSION = PLUGIN_UI_HOST_API_VERSION_V1;

export type GeneratedUiArtifactHostRuntime = Readonly<{
    hostUiApiVersion: string;
}>;

export function generatedUiArtifactCompatibilityFailure(params: Readonly<{
    entry: PluginUiArtifactsManifestEntryV2;
    hostRuntime: GeneratedUiArtifactHostRuntime;
}>): string | null {
    if (!isPluginUiHostApiVersionCompatibleWithVersionV1(
        params.hostRuntime.hostUiApiVersion,
        params.entry.hostUiApiRange,
    )) {
        return 'generated_ui_host_api_mismatch';
    }
    return null;
}

/** Pre-acquisition and load-time admission use the same Host UI API range. */
export function generatedUiArtifactDefaultHostCompatibilityFailure(
    entry: PluginUiArtifactsManifestEntryV2,
): string | null {
    return generatedUiArtifactCompatibilityFailure({
        entry,
        hostRuntime: {
            hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION,
        },
    });
}
