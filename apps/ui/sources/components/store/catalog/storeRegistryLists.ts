import { useRegistryItems } from '@/registries/useRegistryItems';
import type { StoreDemand, StoreListInput } from './storeKinds';

export function useAppList(input: StoreListInput, demand: StoreDemand) {
    return useRegistryItems({ kind: 'app', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}

export function useStarterList(input: StoreListInput, demand: StoreDemand) {
    return useRegistryItems({ kind: 'starter', query: input.query, sourceIds: input.sourceIds }, demand.presented);
}
