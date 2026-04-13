import type { PluginManifestV1 } from '@happier-dev/protocol';

export type PluginCatalogContributionSummary = Readonly<{
  providers: readonly string[];
  backends: readonly string[];
  hooks: readonly string[];
}>;

export function summarizePluginContributions(manifest: Pick<PluginManifestV1, 'contributions'> | null): PluginCatalogContributionSummary {
  if (!manifest) {
    return {
      providers: [],
      backends: [],
      hooks: [],
    };
  }

  return {
    providers: manifest.contributions.providers.map((definition) => definition.id),
    backends: manifest.contributions.backends.map((definition) => definition.id),
    hooks: manifest.contributions.hooks.map((registration) => registration.id),
  };
}
