import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { HappyError } from '@/utils/errors/errors';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { confirmSessionStop, executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_STOP_ID,
    resolveAttentionStandingFromSessionActionId,
    resolveManualReadStateFromSessionActionId,
    SESSION_ACTION_UNPIN_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { createSessionActionDropdownItem } from '@/components/sessions/actions/sessionActionPresentation';
import type { SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';
import type { SessionReminderPresentation } from '@/sync/domains/session/organization/attentionStanding';

import { buildSessionRowMoreMenuItems } from './buildSessionRowActionMenuItems';
import type { SessionRowActionMenuState } from './sessionRowActionMenuTypes';
import { Icon } from '@/components/ui/icons/Icon';
import {
    sessionClearAttentionReminderWithServerScope,
    sessionSetAttentionReminderWithServerScope,
} from '@/sync/ops/sessionOrganization';
import {
    resolveSessionAttentionReminderSelection,
    SESSION_ATTENTION_REMINDER_MENU_ID,
} from './sessionAttentionReminderAction';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
    resolveSessionReminderPresetRule,
    sessionReminderPresetRuleKey,
    upsertSessionReminderPreset,
    type SessionReminderPresetV1,
} from '@/sync/domains/session/organization/sessionReminderPreset';
import { showSessionReminderDateTimeModal, showSessionReminderPresetManagerModal } from './sessionReminderModals';
import {
    resolveSessionAppearanceColorMenuChoice,
    type SessionAppearanceColorMenuInput,
} from '@/components/sessions/shell/appearance/sessionAppearanceColorMenu';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';

function findMenuItem(items: readonly DropdownMenuItem[], itemId: string): DropdownMenuItem | null {
    for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? findMenuItem(item.submenu.items, itemId) : null;
        if (nested) return nested;
    }
    return null;
}

function showActionError(error: unknown) {
    if (error instanceof HappyError) {
        Modal.alert(t('common.error'), error.message);
        return;
    }
    Modal.alert(t('common.error'), t('errors.unknownError'));
}

async function executeLocalSessionAction(params: Readonly<{
    target: SessionActionTarget;
    actionId:
        | typeof SESSION_ACTION_EDIT_TAGS_ID
        | typeof SESSION_ACTION_MOVE_TO_FOLDER_ID
        | typeof SESSION_ACTION_PIN_ID
        | typeof SESSION_ACTION_UNPIN_ID;
    tags?: readonly string[];
    onSetTags?: ((newTags: string[]) => void) | null;
    onTogglePinned?: (() => void) | null;
    onMoveToFolder?: (() => void) | null;
}>): Promise<void> {
    await executeSessionAction({
        actionId: params.actionId,
        target: params.target,
        input: params.tags ? { tags: params.tags } : undefined,
        context: {
            operations: {
                setPinned: () => {
                    params.onTogglePinned?.();
                },
                setTags: (_sessionId, tags) => {
                    params.onSetTags?.([...tags]);
                },
                moveToFolder: () => {
                    params.onMoveToFolder?.();
                },
            },
        },
    });
}

export function useSessionRowActionMenu(params: Readonly<{
    target: SessionActionTarget;
    sessionName: string;
    hideInactiveSessions: boolean;
    iconColor: string;
    activeTags: readonly string[];
    knownTags: readonly string[];
    tagsEnabled: boolean;
    onSetTags?: ((newTags: string[]) => void) | null;
    onTogglePinned?: (() => void) | null;
    onMoveToFolder?: () => void;
    leadingMenuItems?: readonly DropdownMenuItem[];
    trailingMenuItems?: readonly DropdownMenuItem[];
    onSelectCustomMenuItem?: (itemId: string) => void | Promise<void>;
    selectionModeAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    isNativeMobile: boolean;
    setContextMenuOpen: (open: boolean) => void;
    openTagsMenuFromContext: () => void;
    reminder?: SessionReminderPresentation | null;
    /** The canonical archive flow already has this session's archive in flight. */
    archiving?: boolean;
    /** The session's own colour menu; null hides it (server without session appearances). */
    appearance?: (SessionAppearanceColorMenuInput & Readonly<{
        onChange: (color: SessionAppearanceColor | null) => void;
    }>) | null;
    /** Closes this row's open menus (an item that kept them open while it loaded is ready). */
    closeMenus?: () => void;
}>): SessionRowActionMenuState {
    const target = params.target;
    const [customColorPickerLoading, setCustomColorPickerLoading] = React.useState(false);
    const appearanceMenu = React.useMemo(
        () => (params.appearance ? { ...params.appearance, customPickerLoading: customColorPickerLoading } : null),
        [customColorPickerLoading, params.appearance],
    );
    const [reminderPresets, setReminderPresets] = useSettingMutable('sessionReminderPresetsV1');
    const tagMenuItems = React.useMemo((): DropdownMenuItem[] => {
        return params.knownTags.map((tag) => ({
            id: tag,
            title: tag,
            rightElement: params.activeTags.includes(tag) ? (
                <Icon name="check" size={16} color={params.iconColor} />
            ) : undefined,
        }));
    }, [params.activeTags, params.iconColor, params.knownTags]);

    const handleTagMenuSelect = React.useCallback((tagId: string) => {
        if (!params.onSetTags) return;
        const next = params.activeTags.includes(tagId)
            ? params.activeTags.filter((tag) => tag !== tagId)
            : [...params.activeTags, tagId];
        void executeLocalSessionAction({
            target,
            actionId: SESSION_ACTION_EDIT_TAGS_ID,
            tags: next,
            onSetTags: params.onSetTags,
        }).catch(showActionError);
    }, [params.activeTags, params.onSetTags, target]);

    const handleTagMenuCreate = React.useCallback((query: string) => {
        if (!params.onSetTags) return;
        const newTag = query.trim();
        if (!newTag || params.activeTags.includes(newTag)) return;
        void executeLocalSessionAction({
            target,
            actionId: SESSION_ACTION_EDIT_TAGS_ID,
            tags: [...params.activeTags, newTag],
            onSetTags: params.onSetTags,
        }).catch(showActionError);
    }, [params.activeTags, params.onSetTags, target]);

    const [stoppingSession, performStopMutation] = useHappyAction(async () => {
        await executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target,
            context: {
                hideInactiveSessions: params.hideInactiveSessions,
            },
        });
    });

    const [archivingSession, performArchiveMutation] = useHappyAction(async () => {
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target,
            context: {
                hideInactiveSessions: params.hideInactiveSessions,
            },
        });
    });

    const confirmStopSession = React.useCallback(async () => {
        if (!await confirmSessionStop()) return;
        performStopMutation();
    }, [performStopMutation]);

    const confirmArchiveSession = React.useCallback(async () => {
        performArchiveMutation();
    }, [performArchiveMutation]);

    const handleRenameSession = React.useCallback(async () => {
        const newName = await Modal.prompt(
            t('sessionInfo.renameSession'),
            undefined,
            {
                defaultValue: params.sessionName,
                placeholder: t('sessionInfo.renameSessionPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (!newName?.trim()) return;
        try {
            await executeSessionAction({
                actionId: SESSION_ACTION_RENAME_ID,
                target,
                input: { title: newName },
            });
        } catch (error) {
            showActionError(error);
        }
    }, [params.sessionName, target]);

    const handleReadStateAction = React.useCallback(async (targetState: 'read' | 'unread') => {
        try {
            await executeSessionAction({
                actionId: targetState === 'read' ? SESSION_ACTION_MARK_READ_ID : SESSION_ACTION_MARK_UNREAD_ID,
                target,
            });
        } catch (error) {
            showActionError(error);
        }
    }, [target]);

    const handleAttentionStandingAction = React.useCallback(async (standing: boolean) => {
        try {
            await executeSessionAction({
                actionId: standing
                    ? SESSION_ACTION_SET_ATTENTION_STANDING_ID
                    : SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
                target,
            });
        } catch (error) {
            showActionError(error);
        }
    }, [target]);

    const moreMenuItems = React.useMemo(() => {
        const items = buildSessionRowMoreMenuItems({
            target,
            iconColor: params.iconColor,
            leadingItems: params.leadingMenuItems,
            trailingItems: params.trailingMenuItems,
            canMoveToFolder: typeof params.onMoveToFolder === 'function',
            reminderPresets,
            reminder: params.reminder,
            reminderNowMs: Date.now(),
            appearance: appearanceMenu,
        });
        if (
            !params.isNativeMobile
            && params.selectionModeAvailable === true
            && params.selectionModeActive !== true
            && typeof params.onEnterSelectionMode === 'function'
        ) {
            return [
                {
                    id: 'selection.select',
                    title: t('sessionsList.selectionSelectAction'),
                    icon: <Icon name="check-circle" size={16} color={params.iconColor} />,
                },
                ...items,
            ];
        }
        return items;
    }, [
        appearanceMenu,
        params.iconColor,
        params.isNativeMobile,
        params.leadingMenuItems,
        params.trailingMenuItems,
        params.onEnterSelectionMode,
        params.onMoveToFolder,
        params.selectionModeActive,
        params.selectionModeAvailable,
        reminderPresets,
        params.reminder,
        target,
    ]);

    const customMenuItems = React.useMemo(
        () => [...(params.leadingMenuItems ?? []), ...(params.trailingMenuItems ?? [])],
        [params.leadingMenuItems, params.trailingMenuItems],
    );

    const handleMoreMenuSelect = React.useCallback(async (itemId: string) => {
        if (itemId === 'selection.select') {
            params.onEnterSelectionMode?.();
            return;
        }
        if (findMenuItem(customMenuItems, itemId)) {
            await params.onSelectCustomMenuItem?.(itemId);
            return;
        }
        if (params.appearance && itemId.startsWith(`${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}:`)) {
            const appearance = params.appearance;
            try {
                const color = await resolveSessionAppearanceColorMenuChoice({
                    menuId: SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
                    itemId,
                    current: appearance.current,
                    inherited: appearance.inherited,
                    serverId: target.serverId,
                    onPickerLoading: setCustomColorPickerLoading,
                    closeMenus: params.closeMenus,
                });
                if (color !== undefined) appearance.onChange(color);
            } catch (error) {
                showActionError(error);
            }
            return;
        }
        if (itemId.startsWith(`${SESSION_ATTENTION_REMINDER_MENU_ID}:`)) {
            const nowMs = Date.now();
            const selection = resolveSessionAttentionReminderSelection(itemId, nowMs);
            if (selection?.kind === 'current') return;
            if (selection?.kind === 'remove') {
                const result = await sessionClearAttentionReminderWithServerScope(target.sessionId, { serverId: target.serverId });
                if (!result.success) Modal.alert(t('common.error'), result.message ?? t('errors.unknownError'));
                return;
            }
            let remindAt = selection?.kind === 'timestamp' ? selection.remindAt : null;
            let pendingPreset: SessionReminderPresetV1 | null = null;
            if (selection?.kind === 'custom') {
                const result = await showSessionReminderDateTimeModal(nowMs);
                remindAt = result?.remindAt ?? null;
                pendingPreset = result?.preset ?? null;
            } else if (selection?.kind === 'preset') {
                const preset = reminderPresets.find((candidate) => sessionReminderPresetRuleKey(candidate.rule) === selection.ruleKey);
                remindAt = preset ? resolveSessionReminderPresetRule(preset.rule, nowMs) : null;
            } else if (selection?.kind === 'manage_presets') {
                const managed = await showSessionReminderPresetManagerModal(reminderPresets);
                if (managed) setReminderPresets(managed);
            }
            if (remindAt !== null) {
                const result = await sessionSetAttentionReminderWithServerScope(target.sessionId, remindAt, { serverId: target.serverId });
                if (!result.success) {
                    Modal.alert(t('common.error'), result.message ?? t('errors.unknownError'));
                } else if (pendingPreset) {
                    setReminderPresets(upsertSessionReminderPreset(reminderPresets, pendingPreset));
                }
            }
            return;
        }
        const readState = resolveManualReadStateFromSessionActionId(itemId);
        if (readState) {
            await handleReadStateAction(readState);
            return;
        }
        const attentionStanding = resolveAttentionStandingFromSessionActionId(itemId);
        if (attentionStanding !== null) {
            await handleAttentionStandingAction(attentionStanding);
            return;
        }
        switch (itemId) {
            case SESSION_ACTION_MOVE_TO_FOLDER_ID:
                await executeLocalSessionAction({
                    target,
                    actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
                    onMoveToFolder: params.onMoveToFolder,
                });
                break;
            case SESSION_ACTION_RENAME_ID:
                await handleRenameSession();
                break;
            case SESSION_ACTION_STOP_ID:
                await confirmStopSession();
                break;
            case SESSION_ACTION_ARCHIVE_ID:
                await confirmArchiveSession();
                break;
            case SESSION_ACTION_DELETE_ID:
                try {
                    await executeSessionAction({ actionId: SESSION_ACTION_DELETE_ID, target });
                } catch (error) {
                    showActionError(error);
                }
                break;
        }
    }, [
        confirmArchiveSession,
        confirmStopSession,
        handleAttentionStandingAction,
        handleReadStateAction,
        handleRenameSession,
        customMenuItems,
        target,
        params.appearance,
        params.onEnterSelectionMode,
        params.onMoveToFolder,
        params.onSelectCustomMenuItem,
        reminderPresets,
        setReminderPresets,
    ]);

    const contextMenuItems = React.useMemo((): DropdownMenuItem[] => {
        if (!params.isNativeMobile) return [];
        const items: DropdownMenuItem[] = [];
        if (params.selectionModeAvailable === true && typeof params.onEnterSelectionMode === 'function') {
            items.push({
                id: 'selection.select',
                title: t('sessionsList.selectionSelectAction'),
                icon: <Icon name="check-circle" size={14} color={params.iconColor} />,
            });
        }
        if (params.tagsEnabled && typeof params.onSetTags === 'function') {
            const tagsItem = createSessionActionDropdownItem({
                actionId: SESSION_ACTION_EDIT_TAGS_ID,
                iconColor: params.iconColor,
                iconSize: 14,
            });
            if (tagsItem) items.push(tagsItem);
        }
        if (typeof params.onTogglePinned === 'function') {
            const pinItem = createSessionActionDropdownItem({
                actionId: target.isPinned ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID,
                iconColor: params.iconColor,
                iconSize: 14,
            });
            if (pinItem) items.push(pinItem);
        }
        items.push(...moreMenuItems);
        return items;
    }, [
        moreMenuItems,
        params.iconColor,
        params.isNativeMobile,
        params.onEnterSelectionMode,
        params.onSetTags,
        params.onTogglePinned,
        params.selectionModeAvailable,
        params.tagsEnabled,
        target.isPinned,
    ]);

    const handleContextMenuSelect = React.useCallback((itemId: string) => {
        if (itemId === 'selection.select') {
            params.setContextMenuOpen(false);
            params.onEnterSelectionMode?.();
            return;
        }
        if (itemId === SESSION_ACTION_EDIT_TAGS_ID) {
            params.setContextMenuOpen(false);
            params.openTagsMenuFromContext();
            return;
        }
        if (itemId === SESSION_ACTION_PIN_ID || itemId === SESSION_ACTION_UNPIN_ID) {
            params.setContextMenuOpen(false);
            void executeLocalSessionAction({
                target,
                actionId: itemId,
                onTogglePinned: params.onTogglePinned,
            }).catch(showActionError);
            return;
        }
        // An item that loads first keeps the menu open; its owner closes it when ready.
        if (findMenuItem(contextMenuItems, itemId)?.keepMenuOpen) {
            void handleMoreMenuSelect(itemId);
            return;
        }
        params.setContextMenuOpen(false);
        void handleMoreMenuSelect(itemId);
    }, [contextMenuItems, handleMoreMenuSelect, params, target]);

    return {
        tagMenuItems,
        handleTagMenuSelect,
        handleTagMenuCreate,
        moreMenuItems,
        handleMoreMenuSelect,
        contextMenuItems,
        handleContextMenuSelect,
        mutatingSession: stoppingSession || archivingSession || params.archiving === true,
    };
}
