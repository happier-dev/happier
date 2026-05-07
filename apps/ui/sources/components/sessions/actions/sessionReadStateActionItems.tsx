import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import { t } from '@/text';

export const SESSION_MARK_READ_ACTION_ID = 'session.mark-read';
export const SESSION_MARK_UNREAD_ACTION_ID = 'session.mark-unread';

export function createSessionReadStateDropdownItem(
    action: SessionReadStateAction,
    iconColor: string,
): DropdownMenuItem | null {
    if (!action.visible) return null;
    if (action.kind === 'mark-read') {
        return {
            id: SESSION_MARK_READ_ACTION_ID,
            title: t('sessionInfo.markSessionRead'),
            icon: <Ionicons name="mail-open-outline" size={16} color={iconColor} />,
        };
    }
    return {
        id: SESSION_MARK_UNREAD_ACTION_ID,
        title: t('sessionInfo.markSessionUnread'),
        icon: <Ionicons name="mail-unread-outline" size={16} color={iconColor} />,
    };
}

export function createSessionReadStateInfoItemProps(
    action: SessionReadStateAction,
    iconColor: string,
): {
    testID: string;
    title: string;
    subtitle: string;
    icon: React.ReactNode;
} | null {
    if (!action.visible) return null;
    if (action.kind === 'mark-read') {
        return {
            testID: 'session-info-mark-read',
            title: t('sessionInfo.markSessionRead'),
            subtitle: t('sessionInfo.markSessionReadSubtitle'),
            icon: <Ionicons name="mail-open-outline" size={29} color={iconColor} />,
        };
    }
    return {
        testID: 'session-info-mark-unread',
        title: t('sessionInfo.markSessionUnread'),
        subtitle: t('sessionInfo.markSessionUnreadSubtitle'),
        icon: <Ionicons name="mail-unread-outline" size={29} color={iconColor} />,
    };
}

export function resolveSessionReadStateFromActionId(actionId: string): 'read' | 'unread' | null {
    if (actionId === SESSION_MARK_READ_ACTION_ID) return 'read';
    if (actionId === SESSION_MARK_UNREAD_ACTION_ID) return 'unread';
    return null;
}
