import { resolveNavigationPlacements, type NavigationPlacementPreferences } from '@/sync/domains/settings/navigationPlacement';

export type CollectionColumnDeclaration = Readonly<{ id: string; title: string; primary?: boolean; defaultHidden?: boolean }>;

/** Column policy is a two-placement binding of the existing navigation placement owner. */
export function resolveCollectionColumns(columns: readonly CollectionColumnDeclaration[], preferences?: NavigationPlacementPreferences) {
    const primary = columns.find(column => column.primary);
    const result = resolveNavigationPlacements(columns.filter(column => column !== primary).map(column => ({
        ...column,
        defaultPlacement: column.defaultHidden === true ? 'hidden' as const : 'pinned' as const,
        allowedPlacements: ['pinned', 'hidden'] as const,
    })), preferences);
    return {
        ordered: primary ? [primary, ...result.ordered] : result.ordered,
        visibleIds: [...(primary ? [primary.id] : []), ...result.pinned.map(column => column.id)],
    };
}
