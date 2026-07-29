import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { getPreferredLanguage, t } from '@/text';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { LruMap } from '@/utils/cache/lruMap';
import {
    normalizeSessionListFolderSortModeV1,
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListFolderSortMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

const SESSIONS_LIST_HEADER_MENU_ITEMS_CACHE = new LruMap<string, ReadonlyArray<DropdownMenuItem>>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function resolveSessionsListHeaderMenuItems(input: Readonly<{
    orderingMode: string;
    sectionMode: 'activity' | 'single';
    activeGrouping: 'project' | 'date';
    inactiveGrouping: 'project' | 'date';
    isHideInactiveSessionsEnabled: boolean;
    showFolderViewMode: boolean;
    folderViewMode: 'off' | 'tree';
    folderSortMode: 'foldersFirst' | 'mixed';
    showStorageFilter: boolean;
    storageFilter: SessionListStorageFilter;
    actionIconColor: string;
}>): ReadonlyArray<DropdownMenuItem> {
    const cacheKey = [
        getPreferredLanguage(),
        input.orderingMode,
        input.sectionMode,
        input.activeGrouping,
        input.inactiveGrouping,
        input.isHideInactiveSessionsEnabled ? '1' : '0',
        input.showFolderViewMode ? '1' : '0',
        input.folderViewMode,
        input.folderSortMode,
        input.showStorageFilter ? '1' : '0',
        input.storageFilter,
        input.actionIconColor,
    ].join('|');
    const cached = SESSIONS_LIST_HEADER_MENU_ITEMS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const orderingMode = normalizeSessionListOrderingModeV1(input.orderingMode);
    const userFolderSortMode = normalizeSessionListFolderSortModeV1(input.folderSortMode);
    const effectiveFolderSortMode = resolveEffectiveSessionListFolderSortMode({
        orderingMode,
        folderSortMode: userFolderSortMode,
    });
    const isDateOrderingMode = orderingMode !== 'custom';

    const next: DropdownMenuItem[] = [
        ...(input.showStorageFilter ? [{
            id: 'sessionListStorageFilterAll',
            testID: 'session-list-storage-filter-all',
            title: t('sessionsList.storageAllFilter'),
            category: t('sessionsList.storageFilterCategory'),
            rightElement: input.storageFilter === 'all'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        } satisfies DropdownMenuItem, {
            id: 'sessionListStorageFilterPersisted',
            testID: 'session-list-storage-filter-persisted',
            title: t('sessionsList.storagePersistedTab'),
            category: t('sessionsList.storageFilterCategory'),
            rightElement: input.storageFilter === 'persisted'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        } satisfies DropdownMenuItem, {
            id: 'sessionListStorageFilterDirect',
            testID: 'session-list-storage-filter-direct',
            title: t('sessionsList.storageExternalFilter'),
            category: t('sessionsList.storageFilterCategory'),
            rightElement: input.storageFilter === 'direct'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        } satisfies DropdownMenuItem] : []),
        {
            id: 'custom',
            testID: 'session-list-ordering-mode-custom',
            title: t('settingsSession.sessionList.orderingOptions.custom'),
            category: t('settingsSession.sessionList.menuSections.sortBy'),
            rightElement: orderingMode === 'custom'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'created',
            testID: 'session-list-ordering-mode-created',
            title: t('settingsSession.sessionList.orderingOptions.created'),
            category: t('settingsSession.sessionList.menuSections.sortBy'),
            rightElement: orderingMode === 'created'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'updated',
            testID: 'session-list-ordering-mode-updated',
            title: t('settingsSession.sessionList.orderingOptions.updated'),
            category: t('settingsSession.sessionList.menuSections.sortBy'),
            rightElement: orderingMode === 'updated'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'sectionModeActivity',
            title: t('settingsSession.sessionList.sectionModeActivityTitle'),
            subtitle: t('settingsSession.sessionList.sectionModeActivitySubtitle'),
            category: t('settingsSession.sessionList.sectionModeTitle'),
            rightElement: input.sectionMode === 'activity'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'sectionModeSingle',
            title: t('settingsSession.sessionList.sectionModeSingleTitle'),
            subtitle: t('settingsSession.sessionList.sectionModeSingleSubtitle'),
            category: t('settingsSession.sessionList.sectionModeTitle'),
            rightElement: input.sectionMode === 'single'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'activeGroupingProject',
            title: t('settingsFeatures.sessionListGrouping.projectTitle'),
            category: t('settingsFeatures.sessionListActiveGrouping'),
            rightElement: input.activeGrouping === 'project'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'activeGroupingDate',
            title: t('settingsFeatures.sessionListGrouping.dateTitle'),
            category: t('settingsFeatures.sessionListActiveGrouping'),
            rightElement: input.activeGrouping === 'date'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'inactiveGroupingProject',
            title: t('settingsFeatures.sessionListGrouping.projectTitle'),
            category: t('settingsFeatures.sessionListInactiveGrouping'),
            rightElement: input.inactiveGrouping === 'project'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'inactiveGroupingDate',
            title: t('settingsFeatures.sessionListGrouping.dateTitle'),
            category: t('settingsFeatures.sessionListInactiveGrouping'),
            rightElement: input.inactiveGrouping === 'date'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        ...(input.showFolderViewMode ? [{
            id: 'sessionFolderViewModeTree',
            testID: 'session-folder-view-toggle',
            title: t('settingsSession.sessionList.folderTreeView'),
            category: t('settingsSession.sessionList.menuSections.show'),
            rightElement: input.folderViewMode === 'tree'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        } satisfies DropdownMenuItem,
        {
            id: 'sessionListFolderSortModeFoldersFirst',
            testID: 'session-folder-sort-mode-folders-first',
            title: t('settingsSession.sessionList.folderSortModeFoldersFirstTitle'),
            subtitle: t('settingsSession.sessionList.folderSortModeFoldersFirstSubtitle'),
            category: t('settingsSession.sessionList.menuSections.folderSortMode'),
            rightElement: effectiveFolderSortMode === 'foldersFirst'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        } satisfies DropdownMenuItem,
        {
            id: 'sessionListFolderSortModeMixed',
            testID: 'session-folder-sort-mode-mixed',
            title: t('settingsSession.sessionList.folderSortModeMixedTitle'),
            subtitle: isDateOrderingMode
                ? t('settingsSession.sessionList.folderSortModeMixedDisabledInDateModeSubtitle')
                : t('settingsSession.sessionList.folderSortModeMixedSubtitle'),
            category: t('settingsSession.sessionList.menuSections.folderSortMode'),
            disabled: isDateOrderingMode,
            rightElement: effectiveFolderSortMode === 'mixed'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        } satisfies DropdownMenuItem] : []),
        {
            id: 'hideInactiveSessions',
            title: t('settingsFeatures.hideInactiveSessions'),
            category: t('settingsSession.sessionList.menuSections.show'),
            rightElement: input.isHideInactiveSessionsEnabled
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
    ];

    SESSIONS_LIST_HEADER_MENU_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
