import type { PluginReactNativeCompatibilityDecisionV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';

export type PluginReactNativeCompatibilityDecision = Readonly<
    Omit<PluginReactNativeCompatibilityDecisionV1, 'diagnostics'>
    & { diagnostics: readonly string[] }
>;

/** Artifact slot context used locally around the digest-only byte identity. */
export type PluginReactNativeBundleCacheIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactId: string;
    artifactDigest: PluginUiArtifactDigestV1;
    platform: 'web' | 'ios' | 'android';
}>;
