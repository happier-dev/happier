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
    canOpenProject: boolean;
    canAddFolder: boolean;
    canRename: boolean;
    hasCustomLabel: boolean;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    actionIconColor: string;
}>): ReadonlyArray<DropdownMenuItem> {
    const cacheKey = [
        getPreferredLanguage(),
        input.canOpenProject ? '1' : '0',
        input.canAddFolder ? '1' : '0',
        input.canRename ? '1' : '0',
        input.hasCustomLabel ? '1' : '0',
        input.canMoveUp ? '1' : '0',
        input.canMoveDown ? '1' : '0',
        input.actionIconColor,
    ].join('|');
    const cached = PROJECT_GROUP_HEADER_MENU_ITEMS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next: DropdownMenuItem[] = [
        ...(input.canMoveUp ? [{ id: 'moveUp', title: t('common.moveUp') } satisfies DropdownMenuItem] : []),
        ...(input.canMoveDown ? [{ id: 'moveDown', title: t('common.moveDown') } satisfies DropdownMenuItem] : []),
        ...(input.canOpenProject ? [{
            id: 'openProject',
            title: t('sessionsList.openProject'),
            icon: <Icon name="folder" size={16} color={input.actionIconColor} />,
        } satisfies DropdownMenuItem] : []),
        ...(input.canAddFolder ? [{
            id: 'addFolder',
            testID: 'session-folder-add-root',
            title: t('sessionsList.newSection'),
            icon: <Icon name="plus" size={16} color={input.actionIconColor} />,
        } satisfies DropdownMenuItem] : []),
        ...(input.canRename ? [{
            id: 'rename',
            title: t('sessionsList.renameWorkspace'),
            icon: <Icon name="pencil" size={16} color={input.actionIconColor} />,
        } satisfies DropdownMenuItem] : []),
    ];
    if (input.canRename && input.hasCustomLabel) {
        next.push({
            id: 'reset',
            title: t('sessionsList.resetWorkspaceName'),
            icon: <Icon name="arrow-clockwise" size={16} color={input.actionIconColor} />,
        });
    }

    PROJECT_GROUP_HEADER_MENU_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
