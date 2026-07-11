import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

export const SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID = 'session.copyDebugInformation';

export function createCopySessionDebugInformationMenuItem(params: Readonly<{
    iconColor: string;
    iconSize?: number;
}>): DropdownMenuItem {
    return {
        id: SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID,
        title: t('sessionInfo.copyDebugInformation'),
        icon: <Ionicons name="copy-outline" size={params.iconSize ?? 16} color={params.iconColor} />,
    };
}
