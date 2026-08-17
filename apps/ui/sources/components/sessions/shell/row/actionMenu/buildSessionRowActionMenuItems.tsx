import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import {
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { listVisibleSessionActionIds } from '@/components/sessions/actions/sessionActionAvailability';
import { createSessionActionDropdownItem } from '@/components/sessions/actions/sessionActionPresentation';
import { t } from '@/text';

import type { SessionRowMoreMenuBuildParams } from './sessionRowActionMenuTypes';
import { Icon } from '@/components/ui/icons/Icon';

export function buildSessionRowMoreMenuItems(params: SessionRowMoreMenuBuildParams): DropdownMenuItem[] {
    const items: DropdownMenuItem[] = [...(params.leadingItems ?? [])];

    for (const actionId of listVisibleSessionActionIds({ target: params.target, surface: 'rowMenu' })) {
        if (actionId === SESSION_ACTION_MOVE_TO_FOLDER_ID) {
            const folderMoveMenuItems = params.folderMoveMenuItems ?? [];
            if (params.canMoveToFolder === false && folderMoveMenuItems.length === 0) {
                continue;
            }

            items.push({
                id: SESSION_ACTION_MOVE_TO_FOLDER_ID,
                title: t('sessionsList.moveToFolder'),
                icon: <Icon name="folder" size={16} color={params.iconColor} />,
                disabled: params.canMoveToFolder === false
                    ? !folderMoveMenuItems.some((item) => item.disabled !== true)
                    : false,
                submenu: params.canMoveToFolder === false
                    ? {
                        items: folderMoveMenuItems,
                        search: folderMoveMenuItems.length > 8,
                        searchPlaceholder: t('sessionsList.moveToFolder'),
                    }
                    : undefined,
            });
            continue;
        }

        const item = createSessionActionDropdownItem({
            actionId,
            iconColor: params.iconColor,
        });
        if (item) items.push(item);
    }

    return items;
}
