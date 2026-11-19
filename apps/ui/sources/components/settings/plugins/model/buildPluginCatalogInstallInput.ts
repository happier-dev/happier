import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

export function buildPluginCatalogInstallInput(entry: PluginMarketplaceCatalogEntry, machineId: string) {
    if (entry.gitCatalogItemId) {
        return { machineId, source: { kind: 'gitCatalog' as const, sourceId: entry.sourceId, itemId: entry.gitCatalogItemId } };
    }
    return entry.version ? { machineId, source: { kind: 'marketplace' as const, sourceId: entry.sourceId,
        pluginId: entry.id, version: entry.version, packageName: entry.packageName } } : null;
}
