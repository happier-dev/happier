import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';

export const remoteHostColumnAdapter = defineSettingsCollectionAdapter(['status']);
/** Target line and task/tunnel state are produced by the existing remote-host controller. */
export function remoteHostColumnFacts(row: RemoteHost, presentation: Readonly<{
    context: string | null; status: string | null;
}>): SettingsCollectionRowFacts<'status'> {
    return { key: row.id, title: row.name, context: presentation.context, status: presentation.status,
        fields: { status: presentation.status ? [presentation.status] : null } };
}
