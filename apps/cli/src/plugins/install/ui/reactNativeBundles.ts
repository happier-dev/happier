import { derivePluginUiNativeCapabilitiesDigestV1 } from '@happier-dev/protocol';
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

export type ReactNativeBundleCacheIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactDigest: string;
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: PluginUiPlatformV1;
    channel: PluginUiChannelV1;
    nativeCapabilitiesDigest: string;
    projectionGeneration: number;
}>;

export function deriveReactNativeNativeCapabilitiesDigest(
    capabilities: readonly string[],
): string {
    return derivePluginUiNativeCapabilitiesDigestV1(capabilities);
}

export function deriveReactNativeBundleRuntimeCacheKey(
    identity: ReactNativeBundleCacheIdentity,
): string {
    return [
        identity.pluginId,
        identity.contributionId,
        identity.artifactDigest,
        identity.hostAppVersion,
        identity.hostUiApiVersion,
        identity.reactVersion,
        identity.reactNativeVersion,
        identity.expoRuntimeVersion ?? '',
        identity.hermesVersion ?? '',
        identity.platform,
        identity.channel,
        identity.nativeCapabilitiesDigest,
        String(identity.projectionGeneration),
    ].join(':');
}
