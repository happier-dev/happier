import { Platform } from 'react-native';
import {
    HAPPIER_PICKS_SOURCE_ID, REGISTRY_FORMAT_ADAPTERS_V1, registrySourceSupportsKindV1, resolveRegistryFetchPlanV1,
    type RegistryFormatAdapterV1, type RegistryKindV1,
} from '@happier-dev/protocol/registries';
import { useRegistryItems } from './useRegistryItems';
import { useRegistrySources } from './useRegistrySources';
import type { RegistryCatalogItemSummary } from './registryBrandMark';
import * as React from 'react';

const EMPTY_ITEMS: ReturnType<typeof useRegistryItems>['items'] = [];
const EMPTY_CURATION: ReturnType<typeof useRegistryItems>['curation'] = [];
const EMPTY_FAILURES: ReturnType<typeof useRegistryItems>['sourceFailures'] = [];

/** One presented surface acquires its admitted catalog; shelves only project held choices. */
export function useRegistryCuration(input: Readonly<{ sourceIds?: readonly string[] }> = {}, presented = true) {
    const sources = useRegistrySources(undefined, presented);
    const requested = input.sourceIds;
    const selectedSources = React.useMemo(() => sources.sources.filter(source => source.enabled
        && (requested === undefined ? source.format === 'happier-catalog' && registrySourceSupportsKindV1(source, 'plugin') : requested.includes(source.id))),
    [sources.sources, JSON.stringify(requested)]);
    const kind = requested !== undefined && selectedSources.length === 1 && !registrySourceSupportsKindV1(selectedSources[0]!, 'plugin')
        ? selectedSources[0]!.kinds[0]! : 'plugin';
    const sourceIds = React.useMemo(() => selectedSources.filter(source => registrySourceSupportsKindV1(source, kind)).map(source => source.id), [selectedSources, kind]);
    const catalog = useRegistryItems({ kind, sourceIds }, presented && sources.hasValue && sourceIds.length > 0);
    // Presentation owns acquisition, not the admitted facts already held by a retained page.
    const admitted = sourceIds.length > 0 && !catalog.stale;
    const pages = React.useMemo(() => admitted ? catalog.pages : [], [admitted, catalog.pages]);
    // A page carries a settled success or failure. Wait for every admitted source's editorial
    // positions, while failed cold sources cannot veto healthy or retained discovery.
    const hasValue = sources.hasValue && (sourceIds.length === 0 || admitted && catalog.hasValue
        && sourceIds.every(sourceId => catalog.pages.some(page => page.sourceId === sourceId))
        && catalog.pages.some(page => page.status.state === 'ok' || page.discovery !== undefined));
    const error = sources.error ?? catalog.error;
    const status = sources.error ? sources.failureStatus : catalog.status;
    const loading = presented && (sources.loading || sourceIds.length > 0 && catalog.loading);
    const refresh = React.useCallback(async () => { await sources.refresh(); await catalog.refresh(); }, [sources.refresh, catalog.refresh]);
    const layout = React.useMemo(() => ({ hasValue, loading, error, status, refresh, sourceFailures: catalog.sourceFailures }),
        [hasValue, loading, error, status, refresh, catalog.sourceFailures]);
    return React.useMemo(() => ({ ...catalog, pages, ...layout, layout,
        curation: hasValue ? catalog.curation : EMPTY_CURATION, sources: sources.sources,
    }), [catalog, pages, layout, hasValue, sources.sources]);
}
export type RegistryCuration = ReturnType<typeof useRegistryCuration>;

/** Homepage recommendations share registry Actions and their Account-scoped memo.
 * Only a direct built-in first page may replace an empty curated shelf. */
export function useRegistrySuggestions(kind: RegistryKindV1, options?: Readonly<{ curation?: RegistryCuration; enabled?: boolean }>) {
    const enabled = options?.enabled !== false;
    const owned = useRegistryCuration({}, enabled && options?.curation === undefined);
    const curation = options?.curation ?? owned;
    const picks = React.useMemo(() => {
        const seen = new Set<string>();
        return curation.curation.flatMap(page => page.discovery.items.flatMap(item => {
            const ref = item.reference;
            if (ref.type !== 'registryItem' || ref.kind !== kind) return [];
            const key = JSON.stringify(ref);
            if (seen.has(key)) return [];
            seen.add(key);
            const summary: RegistryCatalogItemSummary = { sourceId: ref.sourceId, itemId: ref.itemId, kind: ref.kind,
                title: item.title, ...(item.description === undefined ? {} : { description: item.description }),
                ...(ref.version === undefined ? {} : { version: ref.version }), flags: { pick: true } };
            return [summary];
        }));
    }, [curation.curation, kind]);
    const fallbackSource = curation.sources.find(source => {
        if (!source.enabled || !source.kinds.some(sourceKind => sourceKind === kind) || source.id === HAPPIER_PICKS_SOURCE_ID || source.origin.kind !== 'built_in') return false;
        const adapter = (REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<typeof source.format, RegistryFormatAdapterV1>>)[source.format];
        return adapter && resolveRegistryFetchPlanV1({ host: Platform.OS === 'web' ? 'web' : 'native', source, adapter, op: 'list' })
            .every(placement => placement === 'direct');
    });
    const hasPicks = picks.length > 0;
    const fallback = useRegistryItems({ kind, sourceIds: fallbackSource ? [fallbackSource.id] : [] },
        enabled && !curation.loading && !hasPicks && fallbackSource !== undefined);
    const refresh = React.useCallback(async () => { await curation.refresh(); await fallback.refresh(); },
        [curation.refresh, fallback.refresh]);
    // Explain the acquisition supplying this shelf. A working direct fallback
    // replaces failed curation; absent web fallback must retain its failure.
    const acquisition = hasPicks || !fallbackSource ? curation : fallback;
    return {
        items: !enabled ? EMPTY_ITEMS : hasPicks ? picks : fallbackSource ? fallback.items : EMPTY_ITEMS,
        loading: enabled && (curation.loading || !hasPicks && fallbackSource !== undefined && fallback.loading),
        sourceId: hasPicks ? curation.pages.find(page => page.discovery?.items.some(item =>
            item.reference.type === 'registryItem' && item.reference.kind === kind))?.sourceId ?? null : fallbackSource?.id ?? null,
        error: enabled ? acquisition.error : null,
        status: enabled ? acquisition.status : null,
        sourceFailures: enabled ? acquisition.sourceFailures : EMPTY_FAILURES,
        refresh,
    };
}
