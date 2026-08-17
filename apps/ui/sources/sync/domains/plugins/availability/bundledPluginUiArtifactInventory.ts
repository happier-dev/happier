import { Asset } from 'expo-asset';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';

/**
 * The immutable app-package projection of one Plugin UI Artifact. Availability
 * remains the owner of selection and currentness; this projection only names
 * bytes that the app binary already contains.
 */
export type BundledPluginUiAppArtifactFile = Readonly<{
    relativePath: string;
    asset: Parameters<typeof Asset.fromModule>[0];
}>;

export type BundledPluginUiAppArtifact = Readonly<{
    pluginId: string;
    contributionId: string;
    tier: 'hostedWeb' | 'reactNative';
    platform: 'web' | 'ios' | 'android';
    digest: PluginUiArtifactDigestV1;
    releaseVersion: string;
    files: readonly BundledPluginUiAppArtifactFile[];
}>;

export type BundledPluginUiAppArtifactInventory = readonly BundledPluginUiAppArtifact[];
