import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';

export const pluginColumnAdapter = defineSettingsCollectionAdapter(['source', 'status']);
/** The Marketplace status owner decides attention. Installed and Browse keep their original query owners. */
export function pluginColumnFacts(row: InstalledPluginEntry, status: string | null): SettingsCollectionRowFacts<'source' | 'status'> {
    return { key: row.pluginId, title: row.title ?? row.pluginId, context: row.description ?? null, status,
        fields: { source: [row.source.kind], status: status ? [status] : null } };
}
