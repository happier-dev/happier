import type { PluginDeclaredUiEntriesV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import type { PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui';

/** Typed boundary for the JavaScript build-owned projector consumed by UI tests. */
export interface BundledPluginUiDeclaration {
  pluginId: string;
  pluginVersion: string;
  packageName: string;
  hasMachineProvisioners?: true;
  hasDeploymentTargets?: true;
  hasMachineRecipes?: true;
  displayName: string;
  normalizedManifest: PluginPortableReleaseManifestV1;
  artifactGraphs: readonly PluginUiArtifactsManifestEntryV2[];
  declaredExecution: { daemonActions: boolean; contributionPoints: boolean };
  entriesById: PluginDeclaredUiEntriesV1;
  collectionContracts: PluginCollectionContractRefV1[];
}

interface ProjectionInput {
  packageName: string;
  packageVersion: string;
  artifactGraphs: readonly PluginUiArtifactsManifestEntryV2[];
}

/** Schema-admitted manifests produce a declaration; unknown inputs can be refused. */
export declare function projectBundledPluginUiDeclaration(
  input: ProjectionInput & { manifest: PluginPortableReleaseManifestV1 },
): Promise<BundledPluginUiDeclaration>;
export declare function projectBundledPluginUiDeclaration(
  input: ProjectionInput & { manifest: unknown },
): Promise<BundledPluginUiDeclaration | undefined>;

export declare function projectBundledPluginUiFirstPaintDeclaration(
  declaration: BundledPluginUiDeclaration,
): Promise<Omit<BundledPluginUiDeclaration, 'normalizedManifest'> & {
  presentationManifest: PluginPortableReleaseManifestV1;
  targetedPluginIds: string[];
}>;
