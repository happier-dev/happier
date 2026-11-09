import type { HomeAccountRowV1 } from '@happier-dev/protocol/home/governance';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';

export const homePeopleColumnAdapter = defineSettingsCollectionAdapter(['role', 'status']);
export const homeTeamsColumnAdapter = defineSettingsCollectionAdapter(['status']);
export const homeIdentityProviderColumnAdapter = defineSettingsCollectionAdapter(['status']);

export function homePersonColumnFacts(serverId: string, row: HomeAccountRowV1, presentation: Readonly<{
    name: string; context: string | null;
}>): SettingsCollectionRowFacts<'role' | 'status'> {
    return { key: `${serverId}:person:${row.accountId}`, title: presentation.name, context: presentation.context,
        status: row.status, fields: { role: [row.homeRole], status: [row.status] } };
}
/** Home-scoped admin collections retain their current server search/paging and permission owner. */
export function homeAdministrationColumnFacts(serverId: string, kind: 'team' | 'identityProvider', row: Readonly<{
    id: string; title: string; context: string | null; status: string | null;
}>): SettingsCollectionRowFacts<'status'> {
    return { key: `${serverId}:${kind}:${row.id}`, title: row.title, context: row.context, status: row.status,
        fields: { status: row.status ? [row.status] : null } };
}
