import * as React from 'react';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { useCollectionColumnPreferences } from './useCollectionColumnPreferences';
import { reorderNavigationPlacement, updateNavigationPlacement } from '@/sync/domains/settings/navigationPlacement';
import { buildPlacementReorderBinding } from '@/components/ui/navigation/placementReorderBinding';
import type { EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui';
import { resolveCollectionColumns, type CollectionColumnDeclaration } from './collectionColumns';
import { CollectionColumnPreferencesSchema } from './collectionColumnSettings';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/navigationPlacement';

export type CollectionColumnsController = Readonly<{
    ordered: readonly CollectionColumnDeclaration[];
    visibleIds: readonly string[];
    preferences: NavigationPlacementPreferences;
    setVisible(id: string, visible: boolean): Promise<boolean>;
    reorder(id: string, beforeId: string | null): Promise<boolean>;
    reset(): Promise<boolean>;
    save(preferences: NavigationPlacementPreferences | null): Promise<boolean>;
}>;

/** One key-scoped read per bound Collection, never per row or cell. */
export function useCollectionColumns(collectionId: string, columns: readonly CollectionColumnDeclaration[]): CollectionColumnsController {
    const preferences = useCollectionColumnPreferences(collectionId);
    const write = useSettingActionWriter();
    const commit = React.useCallback(async (value: typeof preferences | null) =>
        (await write({ anchor: 'appearance.collectionColumns' }, { collectionId, preferences: value })).ok, [collectionId, write]);
    const resolved = React.useMemo(() => resolveCollectionColumns(columns, preferences), [columns, preferences]);
    return React.useMemo(() => ({ ...resolved, preferences, save: commit,
        setVisible: (id: string, visible: boolean) => columns.some(column => column.id === id && !column.primary)
            ? commit(updateNavigationPlacement(preferences, id, visible ? 'pinned' : 'hidden')) : Promise.resolve(false),
        reorder: (id: string, beforeId: string | null) => {
            const movable = resolved.ordered.filter(column => !column.primary).map(column => column.id);
            if (!movable.includes(id) || (beforeId !== null && !movable.includes(beforeId))) return Promise.resolve(false);
            const next = reorderNavigationPlacement(preferences, movable, id, beforeId === null
                ? { anchorId: null, placement: 'after' } : { anchorId: beforeId, placement: 'before' });
            return next ? commit(next) : Promise.resolve(false);
        },
        reset: () => commit(null),
    }), [columns, resolved, preferences, commit]);
}

/** Same admission, preview and drop execution as navigation; only the setting binding changes. */
export function buildCollectionColumnReorderBinding(input: Readonly<{
    collectionId: string;
    scope: EntityDragScopeV1 | null;
    controller: CollectionColumnsController;
}>) {
    const { controller, collectionId } = input;
    const items = controller.ordered.filter(column => !column.primary);
    const ids = items.map(column => column.id);
    return buildPlacementReorderBinding({
        scope: input.scope, dragSurfaceId: `collection.columns:${collectionId}`,
        items, orderedIds: ids, moveIdsOf: () => ids, preferences: controller.preferences,
        setting: {
            anchor: 'appearance.collectionColumns',
            valueOf: preferences => ({ collectionId, preferences }),
            read: value => {
                if (!value || typeof value !== 'object' || !('collectionId' in value) || value.collectionId !== collectionId) return null;
                const parsed = CollectionColumnPreferencesSchema.safeParse('preferences' in value ? value.preferences : undefined);
                return parsed.success ? parsed.data : null;
            },
        },
        onChange: controller.save,
    });
}
