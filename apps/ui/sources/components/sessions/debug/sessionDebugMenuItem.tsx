import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

import type { SessionDebugInformation } from './sessionDebugInformation';
import {
    SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID,
    SESSION_COPY_ID_MENU_ITEM_ID,
    SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID,
} from './sessionDebugClipboard';

export const SESSION_COPY_MENU_ITEM_ID = 'session.copy';

export function createSessionCopyMenuItem(params: Readonly<{
    iconColor: string;
    iconSize?: number;
    information: SessionDebugInformation;
}>): DropdownMenuItem {
    const items: DropdownMenuItem[] = [
        { id: SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID, title: t('sessionInfo.sessionInformation') },
        { id: SESSION_COPY_ID_MENU_ITEM_ID, title: t('sessionInfo.happierSessionId') },
    ];
    if (params.information.providerDisplayName && params.information.providerSessionId) {
        items.push({
            id: SESSION_COPY_PROVIDER_ID_MENU_ITEM_ID,
            title: t('sessionInfo.providerSessionId', { provider: params.information.providerDisplayName }),
        });
    }
    return {
        id: SESSION_COPY_MENU_ITEM_ID,
        title: t('common.copy'),
        icon: <Icon name="copy" size={params.iconSize ?? 16} color={params.iconColor} />,
        submenu: { items },
    };
}
