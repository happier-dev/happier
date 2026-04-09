import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { getPreferredLanguage, t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

const PROJECT_GROUP_HEADER_MENU_ITEMS_CACHE = new LruMap<string, ReadonlyArray<DropdownMenuItem>>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function resolveProjectGroupHeaderMenuItems(input: Readonly<{
    menuEnabled: boolean;
    canOpenProject: boolean;
    hasCustomLabel: boolean;
    actionIconColor: string;
}>): ReadonlyArray<DropdownMenuItem> {
    const cacheKey = [
        getPreferredLanguage(),
        input.canOpenProject ? '1' : '0',
        input.hasCustomLabel ? '1' : '0',
        input.actionIconColor,
    ].join('|');
    const cached = PROJECT_GROUP_HEADER_MENU_ITEMS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next: DropdownMenuItem[] = [
        ...(input.canOpenProject ? [{
            id: 'openProject',
            title: t('sessionsList.openProject'),
            icon: <Ionicons name="folder-outline" size={16} color={input.actionIconColor} />,
        } satisfies DropdownMenuItem] : []),
        {
            id: 'rename',
            title: t('sessionsList.renameWorkspace'),
            icon: <Ionicons name="pencil-outline" size={16} color={input.actionIconColor} />,
        },
    ];
    if (input.hasCustomLabel) {
        next.push({
            id: 'reset',
            title: t('sessionsList.resetWorkspaceName'),
            icon: <Ionicons name="refresh-outline" size={16} color={input.actionIconColor} />,
        });
    }

    PROJECT_GROUP_HEADER_MENU_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
