import * as React from 'react';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';
import type { Settings } from '@/sync/domains/settings/settings';
import { EMPTY_NAVIGATION_PLACEMENT_PREFERENCES } from '@/sync/domains/settings/navigationPlacement';
import { CollectionColumnPreferencesSchema } from './collectionColumnSettings';
import { resolveCollectionColumns } from './collectionColumns';

/** One key-scoped preference projection, independent of row count. */
export function useCollectionColumnPreferences(collectionId: string) {
    const select = React.useCallback((settings: Settings) => JSON.stringify(settings.collectionColumnPreferencesV1[collectionId] ?? null), [collectionId]);
    const stored = useSettingsSelector(select, ['collectionColumnPreferencesV1'], `collection.columns:${collectionId}`);
    return React.useMemo(() => {
        const parsed = CollectionColumnPreferencesSchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : EMPTY_NAVIGATION_PLACEMENT_PREFERENCES;
    }, [stored]);
}

/** Host port consumed once by Collection entry; built-in keys retain their declared default. */
export function useCollectionShownFieldKeys(input: Readonly<{ collectionId: string; fields: readonly Readonly<{ key: string; defaultHidden: boolean }>[] }>): readonly string[] {
    const preferences = useCollectionColumnPreferences(input.collectionId);
    return React.useMemo(() => resolveCollectionColumns(input.fields.map(field => ({ id: field.key, title: field.key, defaultHidden: field.defaultHidden })), preferences).visibleIds, [input.fields, preferences]);
}
