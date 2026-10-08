import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import {
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { listVisibleSessionActionIds } from '@/components/sessions/actions/sessionActionAvailability';
import { createSessionActionDropdownItem } from '@/components/sessions/actions/sessionActionPresentation';
import { t } from '@/text';

import { SESSION_ROW_ACTION_SELECT_ID, type SessionRowMoreMenuBuildParams } from './sessionRowActionMenuTypes';
import { Icon } from '@/components/ui/icons/Icon';
import {
    SESSION_ATTENTION_REMINDER_CUSTOM_ID,
    SESSION_ATTENTION_REMINDER_MENU_ID,
    SESSION_ATTENTION_REMINDER_NEXT_WEEK_ID,
    SESSION_ATTENTION_REMINDER_ONE_HOUR_ID,
    SESSION_ATTENTION_REMINDER_THREE_HOURS_ID,
    SESSION_ATTENTION_REMINDER_TOMORROW_ID,
    SESSION_ATTENTION_REMINDER_MANAGE_PRESETS_ID,
    SESSION_ATTENTION_REMINDER_PRESET_PREFIX,
    SESSION_ATTENTION_REMINDER_CURRENT_ID,
    SESSION_ATTENTION_REMINDER_REMOVE_ID,
    formatSessionAttentionReminderDateTime,
    resolveSessionAttentionReminderSelection,
} from './sessionAttentionReminderAction';
import { formatSessionReminderPresetRuleLabel, resolveSessionReminderPresetRule, sessionReminderPresetRuleKey } from '@/sync/domains/session/organization/sessionReminderPreset';

export function buildSessionReminderMenuItem(
    iconColor: string,
    presets: SessionRowMoreMenuBuildParams['reminderPresets'],
    reminder: SessionRowMoreMenuBuildParams['reminder'],
    nowMs: number,
    canSchedule: boolean,
): DropdownMenuItem {
    const selectedAt = reminder?.remindAt ?? null;
    const builtInItems: DropdownMenuItem[] = [
        { id: SESSION_ATTENTION_REMINDER_ONE_HOUR_ID, title: t('sessionsList.reminders.inOneHour') },
        { id: SESSION_ATTENTION_REMINDER_THREE_HOURS_ID, title: t('sessionsList.reminders.inThreeHours') },
        { id: SESSION_ATTENTION_REMINDER_TOMORROW_ID, title: t('sessionsList.reminders.tomorrowMorning') },
        { id: SESSION_ATTENTION_REMINDER_NEXT_WEEK_ID, title: t('sessionsList.reminders.nextWeek') },
    ].map((item) => {
        const selection = resolveSessionAttentionReminderSelection(item.id, nowMs);
        return selection?.kind === 'timestamp' && selection.remindAt === selectedAt ? { ...item, checked: true } : item;
    });
    const savedItems: DropdownMenuItem[] = (presets ?? []).map((preset) => ({
        id: `${SESSION_ATTENTION_REMINDER_PRESET_PREFIX}${sessionReminderPresetRuleKey(preset.rule)}`,
        title: preset.label ?? formatSessionReminderPresetRuleLabel(preset.rule),
        ...(resolveSessionReminderPresetRule(preset.rule, nowMs) === selectedAt ? { checked: true } : {}),
    }));
    const matched = canSchedule && [...builtInItems, ...savedItems].some((item) => item.checked === true);
    return {
        id: SESSION_ATTENTION_REMINDER_MENU_ID,
        title: reminder
            ? reminder.state === 'due'
                ? t('sessionsList.reminders.due')
                : `${t('sessionsList.reminders.title')} · ${formatSessionAttentionReminderDateTime(reminder.remindAt, nowMs)}`
            : t('sessionsList.reminders.title'),
        icon: <Icon name="clock" size={16} color={iconColor} />,
        submenu: {
            items: [
                ...(reminder && !matched ? [{
                    id: SESSION_ATTENTION_REMINDER_CURRENT_ID,
                    title: formatSessionAttentionReminderDateTime(reminder.remindAt, nowMs),
                    checked: true,
                }] : []),
                ...(canSchedule ? builtInItems : []),
                ...(canSchedule ? savedItems : []),
                ...(canSchedule ? [{ id: SESSION_ATTENTION_REMINDER_CUSTOM_ID, title: t('sessionsList.reminders.custom') }] : []),
                ...(canSchedule && (presets?.length ?? 0) > 0 ? [{ id: SESSION_ATTENTION_REMINDER_MANAGE_PRESETS_ID, title: t('sessionsList.reminders.managePresets') }] : []),
                ...(reminder ? [{ id: SESSION_ATTENTION_REMINDER_REMOVE_ID, title: t('sessionsList.reminders.remove') }] : []),
            ],
        },
    };
}

export function buildSessionRowMoreMenuItems(params: SessionRowMoreMenuBuildParams): DropdownMenuItem[] {
    const selectItems = (params.leadingItems ?? []).filter((item) => item.id === SESSION_ROW_ACTION_SELECT_ID);
    const contextualItems = (params.leadingItems ?? []).filter((item) => item.id !== SESSION_ROW_ACTION_SELECT_ID);
    const primaryActionIds = new Set([
        SESSION_ACTION_RENAME_ID,
        SESSION_ACTION_MARK_READ_ID,
        SESSION_ACTION_MARK_UNREAD_ID,
        SESSION_ACTION_SET_ATTENTION_STANDING_ID,
        SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    ]);
    const primaryItems: DropdownMenuItem[] = [];
    const remainingItems: DropdownMenuItem[] = [];
    let moveToFolderItem: DropdownMenuItem | null = null;

    for (const actionId of listVisibleSessionActionIds({ target: params.target, surface: 'rowMenu' })) {
        if (actionId === SESSION_ACTION_MOVE_TO_FOLDER_ID) {
            if (params.canMoveToFolder === false) continue;
            moveToFolderItem = {
                id: SESSION_ACTION_MOVE_TO_FOLDER_ID,
                title: t('sessionsList.moveToFolder'),
                icon: <Icon name="folder" size={16} color={params.iconColor} />,
                disabled: false,
            };
            continue;
        }

        const item = createSessionActionDropdownItem({
            actionId,
            iconColor: params.iconColor,
        });
        if (item) {
            (primaryActionIds.has(actionId) ? primaryItems : remainingItems).push(item);
        }
    }

    primaryItems.sort((left, right) => {
        const priority = (id: string) => id === SESSION_ACTION_RENAME_ID
            ? 0
            : (id === SESSION_ACTION_MARK_READ_ID || id === SESSION_ACTION_MARK_UNREAD_ID)
                ? 1
                : 2;
        return priority(left.id) - priority(right.id);
    });

    return [
        ...selectItems,
        ...primaryItems,
        ...(params.target.reminderAction.canSchedule || (params.reminder && params.target.reminderAction.canClear) ? [buildSessionReminderMenuItem(
            params.iconColor,
            params.reminderPresets,
            params.reminder,
            params.reminderNowMs ?? Date.now(),
            params.target.reminderAction.canSchedule,
        )] : []),
        ...contextualItems,
        ...remainingItems,
        ...(moveToFolderItem ? [moveToFolderItem] : []),
    ];
}
