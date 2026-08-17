import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import React from 'react';
import { getPreferredLanguage, t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';
import { Icon } from '@/components/ui/icons/Icon';

const PROJECT_GROUP_HEADER_MENU_ITEMS_CACHE = new LruMap<string, ReadonlyArray<DropdownMenuItem>>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function resolveProjectGroupHeaderMenuItems(input: Readonly<{
    menuEnabled: boolean;
    canOpenProject: boolean;
    canAddFolder: boolean;
    hasCustomLabel: boolean;
    actionIconColor: string;
}>): ReadonlyArray<DropdownMenuItem> {
    const cacheKey = [
        getPreferredLanguage(),
        input.canOpenProject ? '1' : '0',
        input.canAddFolder ? '1' : '0',
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
            icon: <Icon name="folder" size={16} color={input.actionIconColor} />,
        } satisfies DropdownMenuItem] : []),
        ...(input.canAddFolder ? [{
            id: 'addFolder',
            testID: 'session-folder-add-root',
            title: t('sessionsList.addFolder'),
            icon: <Icon name="folder-open" size={16} color={input.actionIconColor} />,
        } satisfies DropdownMenuItem] : []),
        {
            id: 'rename',
            title: t('sessionsList.renameWorkspace'),
            icon: <Icon name="pencil" size={16} color={input.actionIconColor} />,
        },
    ];
    if (input.hasCustomLabel) {
        next.push({
            id: 'reset',
            title: t('sessionsList.resetWorkspaceName'),
            icon: <Icon name="arrow-clockwise" size={16} color={input.actionIconColor} />,
        });
    }

    PROJECT_GROUP_HEADER_MENU_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
