import { createDefaultCollectionSpaceV1, type CollectionEntityKindV1, type CollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { Settings } from '@/sync/domains/settings/settings';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { readResolvedActiveServerSelection } from '@/sync/domains/server/selection/serverSelectionResolution';
import { getCachedServerFeaturesSnapshot, type ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveMainSelectionFeatureDecision } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { t } from '@/text';

/** Snapshot global defaults for an explicit default edit, never the caller's Team/archive lens. No demand is acquired. */
export function readCollectionSpaceDefaultV1<K extends CollectionEntityKindV1>(entityKind: K, settings: Settings, local: LocalSettings): CollectionSpaceV1<K>;
export function readCollectionSpaceDefaultV1(entityKind: CollectionEntityKindV1, settings: Settings, local: LocalSettings) {
    if (entityKind !== 'sessionWork') return createDefaultCollectionSpaceV1(entityKind, {
        name: t(entityKind === 'workflow' ? 'sessionsList.spacesAllWorkflows' : 'sessionsList.spacesAllDiscussions'),
    });
    const selection = readResolvedActiveServerSelection(settings);
    const homes = selection.allowedServerIds.length ? selection.allowedServerIds : selection.activeServerId ? [selection.activeServerId] : [];
    const snapshotsByServerId: Record<string, ServerFeaturesSnapshot> = {};
    for (const serverId of homes) {
        const snapshot = getCachedServerFeaturesSnapshot({ serverId });
        if (snapshot) snapshotsByServerId[serverId] = snapshot;
    }
    const externalSessionsEnabled = resolveMainSelectionFeatureDecision({ featureId: 'sessions.direct', settings,
        snapshot: { status: Object.keys(snapshotsByServerId).length === homes.length ? 'ready' : 'loading', serverIds: homes, snapshotsByServerId } })?.state === 'enabled';
    const source = externalSessionsEnabled ? local.sessionsListStorageFilter : 'all';
    const { searchQuery: _searchQuery, ...filter } = resolveSessionListViewContextDefaults({ kind: 'global' }, homes, source).defaults;
    return createDefaultCollectionSpaceV1('sessionWork', { name: t('sessionsList.filtersMyWork'), filter });
}
