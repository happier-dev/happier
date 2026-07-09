export type ReactNativeBundleReloadReason =
    | 'installedArtifact'
    | 'devHotReload'
    | 'revoked'
    | 'pluginDisabled'
    | 'pluginUninstalled';

export type ReactNativeBundleReloadInvalidation = Readonly<{
    kind: 'plugin.ui.reactNativeBundle.invalidate';
    pluginId: string;
    contributionId: string;
    artifactDigest: string;
    generation: number;
    reason: ReactNativeBundleReloadReason;
}>;

export function createReactNativeBundleReloadInvalidation(
    input: Omit<ReactNativeBundleReloadInvalidation, 'kind'>,
): ReactNativeBundleReloadInvalidation {
    return Object.freeze({
        kind: 'plugin.ui.reactNativeBundle.invalidate',
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        artifactDigest: input.artifactDigest,
        generation: input.generation,
        reason: input.reason,
    });
}
