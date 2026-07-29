import {
  PluginUiArtifactsManifestEntryV1Schema,
  type PluginUiArtifactsManifestEntryV1,
  type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

import type { ResolvedContributionRegistry } from '../types';

export type ResolvedGeneratedReactNativeArtifactOwner = Readonly<{
  kind: 'renderer' | 'voiceProvider';
  pluginId: string;
  pluginVersion?: string;
  contributionId: string;
  artifactId: string;
  pluginRootPath?: string;
  manifestPath: string;
  generatedUiArtifactsManifest?: PluginUiArtifactsManifestV1;
  requiredHostMethods: readonly string[];
  declaredPlatforms?: readonly ('web' | 'ios' | 'android')[];
}>;

export function collectResolvedGeneratedReactNativeArtifactOwners(
  registry: ResolvedContributionRegistry,
): readonly ResolvedGeneratedReactNativeArtifactOwner[] {
  const owners: ResolvedGeneratedReactNativeArtifactOwner[] = [];
  for (const renderer of registry.uiRenderersV2 ?? []) {
    if (renderer.definition.kind !== 'reactNative') continue;
    owners.push(Object.freeze({
      kind: 'renderer',
      pluginId: renderer.pluginId,
      ...(renderer.pluginVersion ? { pluginVersion: renderer.pluginVersion } : {}),
      contributionId: renderer.definition.id,
      artifactId: renderer.definition.artifact,
      ...(renderer.pluginRootPath ? { pluginRootPath: renderer.pluginRootPath } : {}),
      manifestPath: renderer.manifestPath,
      ...(renderer.generatedUiArtifactsManifest
        ? { generatedUiArtifactsManifest: renderer.generatedUiArtifactsManifest }
        : {}),
      requiredHostMethods: Object.freeze([...(renderer.definition.requiredHostMethods ?? [])]),
    }));
  }
  for (const provider of registry.voiceProviders ?? []) {
    if (provider.definition.kind !== 'conversation') continue;
    owners.push(Object.freeze({
      kind: 'voiceProvider',
      pluginId: provider.pluginId,
      ...(provider.pluginVersion ? { pluginVersion: provider.pluginVersion } : {}),
      contributionId: provider.definition.id,
      artifactId: provider.definition.client.artifactId,
      ...(provider.pluginRootPath ? { pluginRootPath: provider.pluginRootPath } : {}),
      manifestPath: provider.manifestPath,
      ...(provider.generatedUiArtifactsManifest
        ? { generatedUiArtifactsManifest: provider.generatedUiArtifactsManifest }
        : {}),
      requiredHostMethods: Object.freeze([]),
      declaredPlatforms: Object.freeze([...provider.definition.platforms]),
    }));
  }
  return Object.freeze(owners);
}

export function findResolvedGeneratedReactNativeArtifactOwner(input: Readonly<{
  registry: ResolvedContributionRegistry;
  pluginId: string;
  contributionId: string;
}>): ResolvedGeneratedReactNativeArtifactOwner | null {
  const matching = collectResolvedGeneratedReactNativeArtifactOwners(input.registry).filter((owner) => (
    owner.pluginId === input.pluginId && owner.contributionId === input.contributionId
  ));
  return matching.length === 1 ? matching[0]! : null;
}

export function findGeneratedReactNativeArtifactEntry(input: Readonly<{
  owner: ResolvedGeneratedReactNativeArtifactOwner;
  platform: string | undefined;
}>): Readonly<{
  entry: PluginUiArtifactsManifestEntryV1 | null;
  failure: string | null;
}> {
  if (
    input.owner.kind === 'voiceProvider'
    && input.platform
    && !input.owner.declaredPlatforms?.includes(input.platform as 'web' | 'ios' | 'android')
  ) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_platform_undeclared' });
  }
  const candidates = input.owner.generatedUiArtifactsManifest?.entries.filter((entry) => (
    entry.contributionId === input.owner.artifactId && entry.tier === 'reactNative'
  )) ?? [];
  if (candidates.length === 0) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_missing' });
  }
  if (!input.platform) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_platform_unresolved' });
  }
  const matching = candidates.filter((entry) => entry.platform === input.platform);
  if (matching.length !== 1) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_platform_mismatch' });
  }
  const entry = matching[0]!;
  const expectedBundler = entry.platform === 'web' ? 'vite' : 'repack';
  if (entry.builtWith.bundler !== expectedBundler) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_bundler_mismatch' });
  }
  if (entry.platform !== 'web' && !entry.repack) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_repack_identity_missing' });
  }
  if (entry.platform === 'web' && entry.repack) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_repack_identity_unexpected' });
  }
  if (!PluginUiArtifactsManifestEntryV1Schema.safeParse(entry).success) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_graph_invalid' });
  }
  const uniqueFiles = new Set(entry.files.map((file) => file.relativePath));
  if (uniqueFiles.size !== entry.files.length || !uniqueFiles.has(entry.entry)) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_artifact_graph_invalid' });
  }
  if (!input.owner.pluginRootPath) {
    return Object.freeze({ entry: null, failure: 'generated_react_native_plugin_root_unavailable' });
  }
  return Object.freeze({ entry, failure: null });
}
