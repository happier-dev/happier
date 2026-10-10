import * as React from 'react';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MAKE_BOT_ID,
    SESSION_ACTION_MAKE_REGULAR_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_TOOL_CALLS_TOGGLE_ID,
    SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID,
} from './sessionActionIds';
import { resolveSessionToolCallsMenuState } from './sessionToolCallsMenuState';
import { getSessionActionMetadata, resolveSessionActionTitle } from './sessionActionMetadata';
import type { SessionActionId, SessionActionTarget } from './sessionActionTypes';
import { Icon } from '@/components/ui/icons/Icon';

/** Shared delete copy: deleting an offline managed session cannot remove its computer's folder yet. */
export function resolveSessionDeleteWarning(input: Readonly<{
    metadata: unknown;
    machineOnline: boolean;
    defaultWarning: string;
    offlineManagedWarning: string;
}>): string {
    return !input.machineOnline && readSessionDirectoryKind(input.metadata) === 'managed'
        ? `${input.defaultWarning}\n\n${input.offlineManagedWarning}`
        : input.defaultWarning;
}

const MENU_SUBTITLE_ACTION_IDS: ReadonlySet<SessionActionId> = new Set([SESSION_ACTION_MAKE_BOT_ID, SESSION_ACTION_MAKE_REGULAR_ID]);

export function createSessionActionDropdownItem(params: Readonly<{
    actionId: SessionActionId;
    iconColor: string;
    iconSize?: number;
    target?: SessionActionTarget;
    /** The Account's Show tool calls default, so the tool-call rows state what the transcript does. */
    accountShowToolCalls?: boolean | null;
}>): DropdownMenuItem | null {
    const metadata = getSessionActionMetadata(params.actionId);
    if (!metadata) return null;
    const item: DropdownMenuItem = {
        id: params.actionId,
        title: resolveSessionActionTitle(metadata, params.target),
        // Menus stay one line per row except where the row's consequence is the point of the choice.
        ...(metadata.subtitleKey && MENU_SUBTITLE_ACTION_IDS.has(params.actionId) ? { subtitle: t(metadata.subtitleKey) } : {}),
        icon: <Icon name={metadata.icon} size={params.iconSize ?? 16} color={params.iconColor} />,
        ...(metadata.destructive ? { destructive: true } : {}),
    };
    if (params.target && (params.actionId === SESSION_ACTION_TOOL_CALLS_TOGGLE_ID
        || params.actionId === SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID)) {
        const state = resolveSessionToolCallsMenuState({ target: params.target, accountShowToolCalls: params.accountShowToolCalls });
        if (params.actionId === SESSION_ACTION_TOOL_CALLS_TOGGLE_ID) {
            return { ...item, subtitle: t(state.subtitleKey), checked: state.showToolCalls };
        }
        // Use default is offered, but quiet, while the Session follows the default already.
        return state.override === null ? { ...item, disabled: true } : item;
    }
    return item;
}

/** Row props for a session operation on a page. Page rows carry no decorative icon. */
export function createSessionActionInfoItemProps(params: Readonly<{
    actionId: SessionActionId;
    target?: SessionActionTarget;
}>): {
    testID: string;
    title: string;
    subtitle?: string;
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
        title: resolveSessionActionTitle(metadata, params.target),
        subtitle: metadata.subtitleKey ? t(metadata.subtitleKey) : undefined,
    };
}
