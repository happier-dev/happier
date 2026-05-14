import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { getPreferredLanguage, t } from '@/text';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

const SESSIONS_LIST_HEADER_MENU_ITEMS_CACHE = new LruMap<string, ReadonlyArray<DropdownMenuItem>>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function resolveSessionsListHeaderMenuItems(input: Readonly<{
    orderingMode: string;
    activeGrouping: 'project' | 'date';
    inactiveGrouping: 'project' | 'date';
    isHideInactiveSessionsEnabled: boolean;
    showFolderViewMode: boolean;
    folderViewMode: 'off' | 'tree';
    actionIconColor: string;
}>): ReadonlyArray<DropdownMenuItem> {
    const cacheKey = [
        getPreferredLanguage(),
        input.orderingMode,
        input.activeGrouping,
        input.inactiveGrouping,
        input.isHideInactiveSessionsEnabled ? '1' : '0',
        input.showFolderViewMode ? '1' : '0',
        input.folderViewMode,
        input.actionIconColor,
    ].join('|');
    const cached = SESSIONS_LIST_HEADER_MENU_ITEMS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next: DropdownMenuItem[] = [
        {
            id: 'custom',
            title: t('settingsSession.sessionList.orderingOptions.custom'),
            category: t('settingsSession.sessionList.menuSections.sortBy'),
            rightElement: input.orderingMode === 'custom'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'created',
            title: t('settingsSession.sessionList.orderingOptions.created'),
            category: t('settingsSession.sessionList.menuSections.sortBy'),
            rightElement: input.orderingMode === 'created'
                ? <Ionicons name="checkmark" size={16} color={input.actionIconColor} />
                : undefined,
        },
        {
            id: 'updated',
            title: t('settingsSession.sessionList.orderingOptions.updated'),
            category: t('settingsSession.sessionList.menuSections.sortBy'),
            rightElement: input.orderingMode === 'updated'
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
        {
            id: 'hideInactiveSessions',
            title: t('settingsFeatures.hideInactiveSessions'),
            category: t('settingsSession.sessionList.menuSections.show'),
            rightElement: input.isHideInactiveSessionsEnabled
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
        } satisfies DropdownMenuItem] : []),
    ];

    SESSIONS_LIST_HEADER_MENU_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
