import { useLocalSetting } from '@/sync/store/hooks';

export type ResolvedItemDensity = 'comfortable' | 'cozy' | 'compact' | 'tight';

export function useResolvedItemDensity(explicitDensity?: ResolvedItemDensity): ResolvedItemDensity {
    const preferredDensity = useLocalSetting('uiItemDensity');
    return explicitDensity ?? preferredDensity;
}
