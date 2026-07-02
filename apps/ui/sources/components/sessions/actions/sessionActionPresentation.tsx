import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_STOP_ID,
} from './sessionActionIds';
import { getSessionActionMetadata } from './sessionActionMetadata';
import type { SessionActionId } from './sessionActionTypes';

export function createSessionActionDropdownItem(params: Readonly<{
    actionId: SessionActionId;
    iconColor: string;
    iconSize?: number;
}>): DropdownMenuItem | null {
    const metadata = getSessionActionMetadata(params.actionId);
    if (!metadata) return null;
    return {
        id: params.actionId,
        title: t(metadata.titleKey),
        icon: <Ionicons name={metadata.icon} size={params.iconSize ?? 16} color={params.iconColor} />,
    };
}

export function createSessionActionInfoItemProps(params: Readonly<{
    actionId: SessionActionId;
    iconColor: string;
    iconSize?: number;
}>): {
    testID: string;
    title: string;
    subtitle?: string;
    icon: React.ReactNode;
} | null {
    const metadata = getSessionActionMetadata(params.actionId);
    if (!metadata) return null;
    const stableActionId = params.actionId.startsWith('ui.') ? params.actionId.slice(3) : params.actionId;
    const testID = params.actionId === SESSION_ACTION_MARK_READ_ID
        ? 'session-info-mark-read'
        : params.actionId === SESSION_ACTION_MARK_UNREAD_ID
            ? 'session-info-mark-unread'
            : params.actionId === SESSION_ACTION_STOP_ID
                ? 'sessionInfo.stopSession'
                : params.actionId === SESSION_ACTION_ARCHIVE_ID
                    ? 'sessionInfo.archiveSession'
            : params.actionId === SESSION_ACTION_DELETE_ID
                ? 'sessionInfo.deleteSession'
                : `session-info-${stableActionId.replaceAll('.', '-')}`;
    return {
        testID,
        title: t(metadata.titleKey),
        subtitle: metadata.subtitleKey ? t(metadata.subtitleKey) : undefined,
        icon: <Ionicons name={metadata.icon} size={params.iconSize ?? 29} color={params.iconColor} />,
    };
}
