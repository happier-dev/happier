import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createSessionActionDropdownItem } from '@/components/sessions/actions/sessionActionPresentation';
import {
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { buildSessionAppearanceColorMenuItem } from '@/components/sessions/shell/appearance/sessionAppearanceColorMenu';
import { listVisibleSessionActionIds } from '@/components/sessions/actions/sessionActionAvailability';
import { t } from '@/text';

import type { SessionRowMoreMenuBuildParams } from './sessionRowActionMenuTypes';
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
import {
    formatSessionReminderPresetRuleLabel,
    resolveSessionReminderPresetRule,
    sessionReminderPresetRuleKey,
} from '@/sync/domains/session/organization/sessionReminderPreset';

function createReminderPresetItem(
    iconColor: string,
    presets: SessionRowMoreMenuBuildParams['reminderPresets'],
    reminder: SessionRowMoreMenuBuildParams['reminder'],
    nowMs: number,
): DropdownMenuItem {
    const selectedAt = reminder?.remindAt ?? null;
    const check = <Icon name="check" size={16} color={iconColor} />;
    const builtInItems: DropdownMenuItem[] = [
        { id: SESSION_ATTENTION_REMINDER_ONE_HOUR_ID, title: t('sessionsList.reminders.inOneHour') },
        { id: SESSION_ATTENTION_REMINDER_THREE_HOURS_ID, title: t('sessionsList.reminders.inThreeHours') },
        { id: SESSION_ATTENTION_REMINDER_TOMORROW_ID, title: t('sessionsList.reminders.tomorrowMorning') },
        { id: SESSION_ATTENTION_REMINDER_NEXT_WEEK_ID, title: t('sessionsList.reminders.nextWeek') },
    ].map((item) => {
        const selection = resolveSessionAttentionReminderSelection(item.id, nowMs);
        return selection?.kind === 'timestamp' && selection.remindAt === selectedAt
            ? { ...item, rightElement: check }
            : item;
    });
    const savedItems: DropdownMenuItem[] = (presets ?? []).map((preset) => {
        const id = `${SESSION_ATTENTION_REMINDER_PRESET_PREFIX}${sessionReminderPresetRuleKey(preset.rule)}`;
        return {
            id,
            title: preset.label ?? formatSessionReminderPresetRuleLabel(preset.rule),
            ...(resolveSessionReminderPresetRule(preset.rule, nowMs) === selectedAt ? { rightElement: check } : {}),
        };
    });
    const matched = [...builtInItems, ...savedItems].some((item) => item.rightElement !== undefined);
    const currentItem: DropdownMenuItem[] = reminder && !matched ? [{
        id: SESSION_ATTENTION_REMINDER_CURRENT_ID,
        title: formatSessionAttentionReminderDateTime(reminder.remindAt, nowMs),
        rightElement: check,
    }] : [];
    return {
        id: SESSION_ATTENTION_REMINDER_MENU_ID,
        title: reminder
            ? `${t(reminder.state === 'due' ? 'sessionsList.reminders.due' : 'sessionsList.reminders.title')} · ${formatSessionAttentionReminderDateTime(reminder.remindAt, nowMs)}`
            : t('sessionsList.reminders.title'),
        icon: <Icon name="clock" size={16} color={iconColor} />,
        submenu: {
            items: [
                ...currentItem,
                ...builtInItems,
                ...savedItems,
                { id: SESSION_ATTENTION_REMINDER_CUSTOM_ID, title: t('sessionsList.reminders.custom') },
                ...((presets?.length ?? 0) > 0 ? [{
                    id: SESSION_ATTENTION_REMINDER_MANAGE_PRESETS_ID,
                    title: t('sessionsList.reminders.managePresets'),
                }] : []),
                ...(reminder ? [{
                    id: SESSION_ATTENTION_REMINDER_REMOVE_ID,
                    title: t('sessionsList.reminders.remove'),
                }] : []),
            ],
        },
    };
}

export function buildSessionRowMoreMenuItems(params: SessionRowMoreMenuBuildParams): DropdownMenuItem[] {
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
    let appearanceItem: DropdownMenuItem | null = null;
    for (const actionId of listVisibleSessionActionIds({
        target: params.target,
        surface: 'rowMenu',
        sessionAppearancesSupported: params.appearance != null,
    })) {
        if (actionId === SESSION_ACTION_SET_APPEARANCE_COLOR_ID) {
            if (!params.appearance) continue;
            appearanceItem = buildSessionAppearanceColorMenuItem({
                ...params.appearance,
                menuId: SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
                iconColor: params.iconColor,
                base: createSessionActionDropdownItem({ actionId, iconColor: params.iconColor }),
            });
            continue;
        }
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
        ...primaryItems,
        ...(appearanceItem ? [appearanceItem] : []),
        ...(params.target.attentionStandingAction.visible ? [createReminderPresetItem(
            params.iconColor,
            params.reminderPresets,
            params.reminder,
            params.reminderNowMs ?? Date.now(),
        )] : []),
        ...(params.leadingItems ?? []),
        ...remainingItems,
        ...(moveToFolderItem ? [moveToFolderItem] : []),
        ...(params.trailingItems ?? []),
    ];
}
