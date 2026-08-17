export type PluginReactNativeBundleCacheIdentityV1 = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactDigest: string;
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: string;
    channel: string;
    nativeCapabilitiesDigest: string;
}>;

export function deriveReactNativeBundleCacheIdentityKey(
    identity: PluginReactNativeBundleCacheIdentityV1,
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
    ].join(':');
}
