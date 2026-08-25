import {
    derivePluginUiNativeCapabilitiesDigestV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol';
import type {
    PluginUiChannelV1,
    PluginUiPlatformV1,
} from '@happier-dev/protocol/plugins/ui';

export type ReactNativeBundleHostRuntime = Readonly<{
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: PluginUiPlatformV1;
    channel: PluginUiChannelV1;
    availableNativeCapabilities: readonly string[];
    projectionGeneration: number;
}>;

export function deriveReactNativeNativeCapabilitiesDigest(
    capabilities: readonly string[],
): PluginUiArtifactDigestV1 {
    return derivePluginUiNativeCapabilitiesDigestV1(capabilities);
}
