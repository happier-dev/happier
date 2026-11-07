import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import type { ProviderCollectionConnectionRow, ProviderCollectionFoundRow } from './providerCollectionModel';

export const providerColumnAdapter = defineSettingsCollectionAdapter(['status', 'source']);

export function providerConnectionColumnFacts(row: ProviderCollectionConnectionRow, context: string | null): SettingsCollectionRowFacts<'status' | 'source'> {
    return { key: row.connectionId, title: row.title, context, status: row.status,
        count: row.catalogCount?.shown ?? null,
        fields: { status: [row.status], source: row.contributionKey ? [row.contributionKey] : null } };
}

/** Findings stay in their own view; opening this adapter never probes a Machine. */
export function providerFoundColumnFacts(row: ProviderCollectionFoundRow, context: string | null): SettingsCollectionRowFacts<'status' | 'source'> {
    return { key: row.key, title: row.title, context, status: null,
        fields: { status: null, source: [row.kind === 'candidate' ? row.candidate.contributionKey : row.installation.contributionKey] } };
}
