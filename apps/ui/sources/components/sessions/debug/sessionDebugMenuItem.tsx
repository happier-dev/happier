import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export const SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID = 'session.copyDebugInformation';

export function createCopySessionDebugInformationMenuItem(params: Readonly<{
    iconColor: string;
    iconSize?: number;
}>): DropdownMenuItem {
    return {
        id: SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID,
        title: t('sessionInfo.copyDebugInformation'),
        icon: <Icon name="copy" size={params.iconSize ?? 16} color={params.iconColor} />,
    };
}
