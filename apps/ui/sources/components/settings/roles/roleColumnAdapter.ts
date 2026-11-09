import { roleDisplayName, type RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../shell/settingsCollectionAdapter';

export const roleColumnAdapter = defineSettingsCollectionAdapter(['source', 'status']);
export function roleColumnFacts(row: RoleCatalogEntry, context: string | null): SettingsCollectionRowFacts<'source' | 'status'> {
    const status = row.role.enabled ? 'enabled' : 'off';
    return { key: row.roleId, title: roleDisplayName(row.role), context, status: row.role.enabled ? null : 'off',
        fields: { source: [row.source], status: [status] } };
}
