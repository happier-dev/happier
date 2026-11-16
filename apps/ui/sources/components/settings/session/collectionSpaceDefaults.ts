import { createDefaultCollectionSpaceV1, type CollectionEntityKindV1, type CollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { Settings } from '@/sync/domains/settings/settings';
import { readResolvedActiveServerSelection } from '@/sync/domains/server/selection/serverSelectionResolution';
import { resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { t } from '@/text';

import { COLLECTION_SPACE_KIND_PRESENTATION } from './collectionSpaceKindPresentation';

/** Snapshot global defaults for an explicit default edit, never the caller's Team/archive lens. No demand is acquired. */
export function readCollectionSpaceDefaultV1<K extends CollectionEntityKindV1>(entityKind: K, settings: Settings): CollectionSpaceV1<K>;
export function readCollectionSpaceDefaultV1(entityKind: CollectionEntityKindV1, settings: Settings) {
    if (entityKind !== 'sessionWork') return createDefaultCollectionSpaceV1(entityKind, {
        name: t(COLLECTION_SPACE_KIND_PRESENTATION[entityKind].defaultNameKey),
    });
    const selection = readResolvedActiveServerSelection(settings);
    const homes = selection.allowedServerIds.length ? selection.allowedServerIds : selection.activeServerId ? [selection.activeServerId] : [];
    const { searchQuery: _searchQuery, ...filter } = resolveSessionListViewContextDefaults({ kind: 'global' }, homes, 'all').defaults;
    return createDefaultCollectionSpaceV1('sessionWork', { name: t('sessionsList.filtersMyWork'), filter });
}
