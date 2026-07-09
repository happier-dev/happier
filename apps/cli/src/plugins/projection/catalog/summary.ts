import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

export type PluginCatalogContributionSummary = Readonly<{
  agents: readonly string[];
  agentRuntimes: readonly string[];
  actions: readonly string[];
  tools: readonly string[];
  commands: readonly string[];
  resources: readonly string[];
  uiDescriptors: readonly string[];
  settings: readonly string[];
  hooks: readonly string[];
  hostedWeb: readonly string[];
  embeddedWebBundles: readonly string[];
  reactNativeBundles: readonly string[];
  uiArtifacts: readonly string[];
  surfacePlacements: readonly string[];
}>;

export function summarizePluginContributes(
  manifest: Pick<CanonicalPluginManifest, 'contributes'> | null,
): PluginCatalogContributionSummary {
  if (!manifest) {
    return {
      agents: [],
      agentRuntimes: [],
      actions: [],
      tools: [],
      commands: [],
      resources: [],
      uiDescriptors: [],
      settings: [],
      hooks: [],
      hostedWeb: [],
      embeddedWebBundles: [],
      reactNativeBundles: [],
      uiArtifacts: [],
      surfacePlacements: [],
    };
  }

  function readIds(definitions: readonly unknown[] | undefined): readonly string[] {
    return (definitions ?? []).flatMap((definition) => {
      if (typeof definition !== 'object' || definition === null || !('id' in definition)) {
        return [];
      }

      const id = definition.id;
      return typeof id === 'string' ? [id] : [];
    });
  }

  return {
    agents: readIds(manifest.contributes.agents),
    agentRuntimes: readIds(manifest.contributes.agentRuntimes),
    actions: readIds(manifest.contributes.actions),
    tools: readIds(manifest.contributes.tools),
    commands: readIds(manifest.contributes.commands),
    resources: readIds(manifest.contributes.resources),
    uiDescriptors: readIds(manifest.contributes.uiDescriptors),
    settings: readIds(manifest.contributes.settings),
    hooks: readIds(manifest.contributes.hooks),
    hostedWeb: readIds(manifest.contributes.hostedWeb),
    embeddedWebBundles: readIds(manifest.contributes.embeddedWebBundles),
    reactNativeBundles: readIds(manifest.contributes.reactNativeBundles),
    uiArtifacts: readIds(manifest.contributes.uiArtifacts),
    surfacePlacements: readIds(manifest.contributes.surfacePlacements),
  };
}
