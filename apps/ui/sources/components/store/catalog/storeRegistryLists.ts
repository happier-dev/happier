import { useMemo } from 'react';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '@happier-dev/protocol/registries';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { useRegistryItems } from '@/registries/useRegistryItems';
import type { StoreDemand, StoreListInput } from './storeKinds';

const nativeAppCatalogIds = new Set(BUILT_IN_REGISTRY_SOURCES_V1
    .filter(source => source.format === 'coolify-templates' || source.format === 'dokploy-templates')
    .map(source => source.id));

/** The quick picker groups native templates only when their catalog id and upstream project agree.
 * The chosen row still carries its exact source and item id for preparation. */
function appChoiceIdentity(item: RegistryCatalogItemSummary): string {
    if (nativeAppCatalogIds.has(item.sourceId) && item.links?.website) {
        try {
            const site = new URL(item.links.website);
            if (site.protocol === 'https:' || site.protocol === 'http:') {
                return JSON.stringify(['upstream', site.host, item.itemId]);
            }
        } catch {
            // An invalid upstream link cannot identify a template across catalogs.
        }
    }
    return JSON.stringify(['catalog', item.sourceId, item.itemId]);
}

export function useAppList(input: StoreListInput, demand: StoreDemand) {
    const read = useRegistryItems({ kind: 'app', query: input.query, sourceIds: input.sourceIds }, demand.presented);
    const items = useMemo(() => {
        const choices = new Map<string, { item: RegistryCatalogItemSummary; available: boolean }>();
        for (const page of read.pages) {
            for (const item of page.items) {
                const identity = appChoiceIdentity(item);
                const existing = choices.get(identity);
                const available = page.status.state === 'ok' && item.problem === undefined;
                if (!existing || (!existing.available && available)) choices.set(identity, { item, available });
            }
        }
        return Array.from(choices.values(), ({ item }) => item);
    }, [read.pages]);
    return { ...read, items };
}

export function useStarterList(input: StoreListInput, demand: StoreDemand) {
    return useRegistryItems({ kind: 'starter', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}

export function useDeploymentStarterList(input: StoreListInput, demand: StoreDemand, hasOnlineMachine: boolean) {
    const read = useStarterList(input, demand);
    const items = useMemo(() => read.items.filter(item => item.starterDeploy !== undefined), [read.items]);
    if (items.length > 0) return { read, items, state: 'results' as const };
    if (read.loading || (!read.hasValue && !read.error)) return { read, items, state: 'loading' as const };
    if (read.sourceFailures.length > 0) {
        const needsMachine = read.sourceFailures.every(failure => failure.status.state === 'needs_machine');
        return { read, items, state: needsMachine ? 'needsMachine' as const : 'results' as const };
    }
    if (read.error) return { read, items, state: 'results' as const };
    if (input.query) return { read, items, state: 'noMatches' as const };
    return { read, items, state: hasOnlineMachine ? 'empty' as const : 'needsMachine' as const };
}
