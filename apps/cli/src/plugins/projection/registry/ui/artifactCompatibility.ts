import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import type { PluginUiArtifactsManifestEntryV1 } from '@happier-dev/protocol/plugins/ui';

export const PLUGIN_UI_REACT_VERSION = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.react;
export const PLUGIN_UI_REACT_NATIVE_VERSION = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.reactNative;
export const PLUGIN_UI_HOST_API_VERSION = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion;

export type GeneratedUiArtifactHostRuntime = Readonly<{
    hostUiApiVersion: string;
    reactVersion?: string;
    reactNativeVersion?: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
}>;

export function generatedUiArtifactCompatibilityFailure(params: Readonly<{
    entry: PluginUiArtifactsManifestEntryV1;
    hostRuntime: GeneratedUiArtifactHostRuntime;
}>): string | null {
    if (params.entry.hostUiApiVersion !== params.hostRuntime.hostUiApiVersion) {
        return 'generated_ui_host_api_mismatch';
    }
    if (
        params.entry.tier === 'reactNative'
        && params.entry.compat.react !== params.hostRuntime.reactVersion
    ) {
        return 'generated_ui_react_runtime_mismatch';
    }
    if (
        params.entry.tier === 'reactNative'
        && params.entry.compat.reactNative !== params.hostRuntime.reactNativeVersion
    ) {
        return 'generated_react_native_runtime_mismatch';
    }
    if (
        params.entry.compat.expoRuntime !== undefined
        && params.entry.compat.expoRuntime !== params.hostRuntime.expoRuntimeVersion
    ) {
        return 'generated_react_native_runtime_mismatch';
    }
    if (
        params.entry.compat.hermes !== undefined
        && params.entry.compat.hermes !== params.hostRuntime.hermesVersion
    ) {
        return 'generated_react_native_runtime_mismatch';
    }
    return null;
}

/**
 * The pre-acquisition host identity is this host build's own generated
 * toolchain packet and nothing else. The daemon has no device-reported Expo
 * runtime or Hermes identity at candidate-selection time, so an Artifact that
 * pins one is refused here exactly as the load-time projection gate refuses it
 * against a host runtime that reports none. Never derive a host field from the
 * entry being checked: that compares the Artifact against itself.
 */
export function generatedUiArtifactDefaultHostCompatibilityFailure(
    entry: PluginUiArtifactsManifestEntryV1,
): string | null {
    return generatedUiArtifactCompatibilityFailure({
        entry,
        hostRuntime: {
            hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION,
            ...(entry.tier === 'reactNative'
                ? {
                    reactVersion: PLUGIN_UI_REACT_VERSION,
                    reactNativeVersion: PLUGIN_UI_REACT_NATIVE_VERSION,
                }
                : {}),
        },
    });
}
