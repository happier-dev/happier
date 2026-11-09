import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../shell/settingsCollectionAdapter';

export const secretColumnAdapter = defineSettingsCollectionAdapter(['status']);
/** Accept only the privacy-projected row: never accept a SecretString or resolve secret material. */
export function secretColumnFacts(row: Readonly<{
    key: string; name: string; context: string | null; status: string | null;
}>): SettingsCollectionRowFacts<'status'> {
    return { key: row.key, title: row.name, context: row.context, status: row.status,
        fields: { status: row.status ? [row.status] : null } };
}
