import type { Asset } from 'expo-asset';
import type { PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui';
import type { PluginDeclaredUiEntriesV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import type { PluginUiDeclaredExecution } from '../ui/projection';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

export type PluginHostBundledUiDeclaration = Readonly<{
    pluginId: string;
    pluginVersion: string;
    /** Canonical package custody locator from the app dependency inventory. */
    packageName: string;
    displayName: string;
    /** Demand index from the canonical declaration projector; schemas stay lazy. */
    hasMachineProvisioners?: boolean;
    entriesById: PluginDeclaredUiEntriesV1;
    /** Validated authored facts retained by the existing bundled declaration producer. */
    normalizedManifest?: PluginPortableReleaseManifestV1;
    /** Discovery-only Account descriptors; never supplied to an invocation. */
    presentationManifest?: PluginPortableReleaseManifestV1;
    /** Exact build-owned declaration, acquired only for this plugin's demand. */
    loadDeclaration?: () => Promise<PluginHostBundledUiDeclaration>;
    /** Declaration suppliers needed when this plugin's contribution points are opened. */
    targetedPluginIds?: readonly string[];
    /** Exact compiler output, including portable Account activation exports. */
    artifactGraphs?: readonly PluginUiArtifactsManifestEntryV2[];
    /** Static requirements remain known before a Machine publishes its runtime catalog. */
    declaredExecution?: PluginUiDeclaredExecution;
    /** Reader identities compiled from this app's bundled manifest, never daemon writer refs. */
    collectionContracts?: readonly PluginCollectionContractRefV1[];
}>;

/**
 * The immutable app-package projection of one Plugin UI Artifact. Availability
 * remains the owner of selection and currentness; this projection supplies
 * only the bytes the app already contains.
 */
export type BundledPluginUiAppArtifactFile = Readonly<{
    relativePath: string;
    asset: Parameters<typeof Asset.fromModule>[0];
}>;

export type BundledPluginUiAppArtifact = Readonly<{
    pluginId: string;
    artifactId: string;
    tier: 'hostedWeb' | 'reactNative';
    digest: PluginUiArtifactDigestV1;
    releaseVersion: string;
    artifactGraph?: PluginUiArtifactsManifestEntryV2;
    files: readonly BundledPluginUiAppArtifactFile[];
}>;

export type BundledPluginUiAppArtifactInventory = readonly BundledPluginUiAppArtifact[];

/** Manifest-declared packaged marks; descriptive app bytes, never execution authority. */
export type BundledPluginBrandMark = Readonly<{
    pluginId: string;
    displayName: string;
    resourceId: string;
    releaseVersion: string;
    digest: PluginUiArtifactDigestV1;
    bytes: Uint8Array;
    monochrome?: boolean;
}>;
