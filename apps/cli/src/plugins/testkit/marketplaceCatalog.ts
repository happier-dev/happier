import type { PluginMarketplaceEntryV1 } from '@happier-dev/protocol';

export function createMarketplaceCatalogEntry(params: Readonly<{
  pluginId: string;
  entryId?: string;
  title?: string;
  description?: string;
  version?: string;
  sourceUrl: string;
  packageUrl?: string;
  digest?: string;
  categories?: readonly string[];
}>): PluginMarketplaceEntryV1 {
  return {
    id: params.entryId ?? `marketplace.${params.pluginId}`,
    manifestId: params.pluginId,
    title: params.title ?? params.pluginId,
    version: params.version,
    description: params.description,
    sourceUrl: params.sourceUrl,
    packageUrl: params.packageUrl,
    digest: params.digest,
    categories: [...(params.categories ?? [])],
  };
}

export function createMarketplaceCatalogDocument(params: Readonly<{
  sourceUrl: string;
  title: string;
  description?: string;
  entries: readonly PluginMarketplaceEntryV1[];
}>): Readonly<{
  t: 'happier_plugin_marketplace_catalog_v1';
  schemaVersion: 1;
  sourceUrl: string;
  title: string;
  description?: string;
  entries: readonly PluginMarketplaceEntryV1[];
}> {
  return {
    t: 'happier_plugin_marketplace_catalog_v1',
    schemaVersion: 1,
    sourceUrl: params.sourceUrl,
    title: params.title,
    description: params.description,
    entries: [...params.entries],
  };
}
