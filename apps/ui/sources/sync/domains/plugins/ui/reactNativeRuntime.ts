import type { PluginReactNativeCompatibilityDecisionV1 } from '@happier-dev/protocol';
import {
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginReactNativeCompatibilityDecision = Readonly<
    Omit<PluginReactNativeCompatibilityDecisionV1, 'diagnostics'>
    & { diagnostics: readonly string[] }
>;

export type PluginReactNativeBundleCacheIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactDigest: PluginUiArtifactDigestV1;
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: string;
    channel: string;
    nativeCapabilitiesDigest: PluginUiArtifactDigestV1;
    projectionGeneration: number;
}>;

export function derivePluginReactNativeBundleCacheKey(
    identity: PluginReactNativeBundleCacheIdentity,
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
