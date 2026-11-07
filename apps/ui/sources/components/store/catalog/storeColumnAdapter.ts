import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import { compileEntityListFilterV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import { actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { defineSettingsCollectionAdapter, type SettingsCollectionFilter,
    type SettingsCollectionRowFacts } from '@/components/settings/shell/settingsCollectionAdapter';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';
import { storeKinds, type StoreKind } from './storeKinds';
import { storeEditorialGroupKey } from './storeEditorialIdentity';
export { storeEditorialGroupKey } from './storeEditorialIdentity';

export const storeColumnAdapter = defineSettingsCollectionAdapter(['kind', 'source', 'category', 'job']);
export type StoreColumnField = typeof storeColumnAdapter.fields[number];
export type StoreSearchRow = { [Kind in StoreKind]: Readonly<{
    key: string; kind: Kind; summary: ReturnType<(typeof storeKinds)[Kind]['summary']>;
}> }[StoreKind];

const softwareReferenceKey = (value: JsonValue) => JSON.stringify(['software', actionInputOptionValueKey(value)]);

function referenceKey(ref: MarketplaceCatalogReferenceV1): string {
    switch (ref.type) {
        case 'registryItem': return JSON.stringify([ref.kind, ref.sourceId, ref.itemId]);
        case 'providerContribution': return JSON.stringify(['provider', ref.contributionKey]);
        case 'agentContribution': return JSON.stringify(['agent', ref.targetKey]);
        case 'software': return softwareReferenceKey(ref.value);
    }
}
function nativeReference(row: StoreSearchRow): MarketplaceCatalogReferenceV1 | null {
    switch (row.kind) {
        case 'software': return null; // Its held option value supplies the editorial key below, not a Registry pointer.
        case 'provider': return { type: 'providerContribution', contributionKey: row.summary.ref.contributionKey };
        case 'agent': {
            const ref = row.summary.ref;
            if (!('itemId' in ref)) return ref.backendTargetKey ? { type: 'agentContribution', targetKey: ref.backendTargetKey } : null;
            return { type: 'registryItem', kind: ref.kind, sourceId: ref.sourceId, itemId: ref.itemId,
                ...(ref.version ? { version: ref.version } : {}) };
        }
        case 'plugin': return row.summary.ref.itemId ? { type: 'registryItem', kind: 'plugin',
            sourceId: row.summary.ref.sourceId, itemId: row.summary.ref.itemId,
            ...(row.summary.ref.version ? { version: row.summary.ref.version } : {}) } : null;
        case 'app': case 'browserExtension': case 'mcpServer': case 'skill': return { type: 'registryItem', kind: row.summary.ref.kind,
            sourceId: row.summary.ref.sourceId, itemId: row.summary.ref.itemId,
            ...(row.summary.ref.version ? { version: row.summary.ref.version } : {}) };
    }
}

/** No acquisition/evaluator here: this binds admitted native refs and editorial membership to the shared registry. */
export function storeRowFacts(rows: readonly StoreSearchRow[], curation: RegistryCuration['curation'], complete: boolean): readonly SettingsCollectionRowFacts<StoreColumnField>[] {
    const memberships = new Map<string, { version?: string; category: string[]; job: string[] }[]>();
    for (const page of curation) {
        const byId = new Map(page.discovery.items.map(item => [item.id, { reference: item.reference, category: [] as string[], job: [] as string[] }]));
        for (const category of page.discovery.categories) for (const id of category.items)
            byId.get(id)?.category.push(storeEditorialGroupKey(page.sourceId, category.id));
        for (const job of page.discovery.jobs) for (const group of job.groups) for (const id of group.items)
            byId.get(id)?.job.push(storeEditorialGroupKey(page.sourceId, job.id));
        for (const item of byId.values()) {
            const key = referenceKey(item.reference);
            const value = { ...('version' in item.reference ? { version: item.reference.version } : {}), category: item.category, job: item.job };
            const existing = memberships.get(key);
            if (existing) existing.push(value); else memberships.set(key, [value]);
        }
    }
    return rows.map(row => {
        const ref = nativeReference(row);
        const key = row.kind === 'software' ? softwareReferenceKey(row.summary.ref.value) : ref ? referenceKey(ref) : null;
        const editorial = key ? memberships.get(key)?.filter(item => !item.version
            || ref?.type === 'registryItem' && ref.version === item.version) ?? [] : [];
        const nativeCategories = row.kind === 'plugin' ? row.summary.ref.categories : [];
        return { key: row.key, title: row.summary.title, context: row.summary.description ?? null, status: null,
            fields: { kind: [row.kind], source: ref?.type === 'registryItem' ? [ref.sourceId] : null,
                category: complete || nativeCategories.length ? [...nativeCategories, ...editorial.flatMap(item => item.category)] : null,
                job: complete ? editorial.flatMap(item => item.job) : null } };
    });
}

/** Remote demand uses the very same condition compiler as rendered results. */
export function storeDemandMatches(filters: SettingsCollectionFilter, fields: Partial<Record<'kind' | 'source', readonly string[] | null>>): boolean {
    const narrowed = Object.fromEntries(Object.keys(fields).map(field => [field, filters[field]]));
    return compileEntityListFilterV1(storeColumnAdapter.registry, narrowed)({ key: '', title: '', context: null, status: null, fields }) === 'match';
}
