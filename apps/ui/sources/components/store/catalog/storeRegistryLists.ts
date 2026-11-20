import { useMemo } from 'react';
import { useRegistryItems } from '@/registries/useRegistryItems';
import type { StoreDemand, StoreListInput } from './storeKinds';

export function useAppList(input: StoreListInput, demand: StoreDemand) {
    return useRegistryItems({ kind: 'app', query: input.query, sourceIds: input.sourceIds }, demand.presented);
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
