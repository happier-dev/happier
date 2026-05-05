import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

export type PluginCatalogContributionSummary = Readonly<{
  providers: readonly string[];
  backends: readonly string[];
  hooks: readonly string[];
}>;

export function summarizePluginContributes(
  manifest: Pick<CanonicalPluginManifest, 'contributes'> | null,
): PluginCatalogContributionSummary {
  if (!manifest) {
    return {
      providers: [],
      backends: [],
      hooks: [],
    };
  }

  function readIds(definitions: readonly unknown[]): readonly string[] {
    return definitions.flatMap((definition) => {
      if (typeof definition !== 'object' || definition === null || !('id' in definition)) {
        return [];
      }

      const id = definition.id;
      return typeof id === 'string' ? [id] : [];
    });
  }

  return {
    providers: readIds(manifest.contributes.providers),
    backends: readIds(manifest.contributes.backends),
    hooks: readIds(manifest.contributes.hooks),
  };
}
