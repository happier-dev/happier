import { useSessionArchivePending } from '@/hooks/session/useSessionArchivePending';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { confirmSessionDelete } from '@/components/sessions/actions/confirmSessionDelete';
import { confirmSessionArchive } from '@/components/sessions/actions/confirmSessionArchive';
import * as React from 'react';
import type { View } from 'react-native';

import type { DropdownMenuItem, DropdownMenuSelection } from '@/components/ui/forms/dropdown/DropdownMenu';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_PUT_UNDER_ID,
    SESSION_ACTION_COORDINATOR_MAKE_ID,
    SESSION_ACTION_COORDINATOR_EDIT_ID,
    SESSION_ACTION_COORDINATOR_ANSWERS_ID,
    SESSION_ACTION_COORDINATOR_STOP_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_RAIL_PIN_ID,
    SESSION_ACTION_RAIL_UNPIN_ID,
    SESSION_ACTION_WORK_OPEN_ID,
    SESSION_ACTION_TALK_ID,
    SESSION_ACTION_MAKE_BOT_ID,
    SESSION_ACTION_MAKE_REGULAR_ID,
    SESSION_ACTION_TOOL_CALLS_TOGGLE_ID,
    SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
    SESSION_ACTION_UNPIN_ID,
    resolveAttentionStandingFromSessionActionId,
    resolveManualReadStateFromSessionActionId,
} from '@/components/sessions/actions/sessionActionIds';
import { createSessionActionDropdownItem } from '@/components/sessions/actions/sessionActionPresentation';
import { forgetRailPinOrigin, measureWindowRect, noteRailPinOrigin } from '@/components/sessions/bots/railPinFlight';
import type { SessionActionExecutionOperations, SessionActionId, SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';
import type { SessionReminderPresentation } from '@/sync/domains/session/organization/attentionStanding';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

import { buildSessionRowMoreMenuItems } from './buildSessionRowActionMenuItems';
import {
    resolveSessionAppearanceColorMenuChoice,
    type SessionAppearanceColorMenuInput,
} from '@/components/sessions/organization/sessionAppearanceColorMenu';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { SESSION_ACTION_SET_APPEARANCE_COLOR_ID } from '@/components/sessions/actions/sessionActionIds';
import { readSessionSectionMoveMenuChoice } from '@/components/sessions/organization/sessionSectionMoveMenu';
import type { SessionRowSectionMove, SessionRowSpaceMembership } from '../../useSessionListRowMoveActionHandlers';
import { Icon } from '@/components/ui/icons/Icon';
import { sessionClearAttentionReminderWithServerScope, sessionSetAttentionReminderWithServerScope } from '@/sync/ops/sessionOrganization';
import { buildSessionTagsMenuContent } from '@/components/sessions/organization/SessionTagsMenuContent';
import {
    SESSION_ROW_ACTION_OPEN_ID,
    SESSION_ROW_ACTION_SELECT_ID,
    type SessionRowActionMenuState,
} from './sessionRowActionMenuTypes';
import { handleSessionReminderMenuSelection, isSessionReminderMenuItemId } from './handleSessionReminderMenuSelection';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useApplySessionReminderPresetIntent } from '@/sync/store/settingsWriters';
import { useSessionRowPluginActions } from './useSessionRowPluginActions';

function findMenuItem(items: readonly DropdownMenuItem[], itemId: string): DropdownMenuItem | null {
    for (const item of items) {
        if (item.id === itemId) return item;
        const nested = item.submenu ? findMenuItem(item.submenu.items, itemId) : null;
        if (nested) return nested;
    }
    return null;
}

function showActionError(error: unknown): void {
    if (error instanceof HappyError) {
        Modal.alert(t('common.error'), error.message);
        return;
    }
    Modal.alert(t('common.error'), t('errors.unknownError'));
}

function resolveActionIdFromMenuItemId(itemId: string): SessionActionId | null {
    switch (itemId) {
        case SESSION_ACTION_RENAME_ID:
        case SESSION_ACTION_STOP_ID:
        case SESSION_ACTION_ARCHIVE_ID:
        case SESSION_ACTION_UNARCHIVE_ID:
        case SESSION_ACTION_DELETE_ID:
        case SESSION_ACTION_PIN_ID:
        case SESSION_ACTION_UNPIN_ID:
        case SESSION_ACTION_EDIT_TAGS_ID:
        case SESSION_ACTION_PUT_UNDER_ID:
        case SESSION_ACTION_RAIL_PIN_ID:
        case SESSION_ACTION_RAIL_UNPIN_ID:
        case SESSION_ACTION_WORK_OPEN_ID:
        case SESSION_ACTION_TALK_ID:
        case SESSION_ACTION_MAKE_BOT_ID:
        case SESSION_ACTION_MAKE_REGULAR_ID:
        case SESSION_ACTION_TOOL_CALLS_TOGGLE_ID:
        case SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID:
        case SESSION_ACTION_COORDINATOR_MAKE_ID:
        case SESSION_ACTION_COORDINATOR_EDIT_ID:
        case SESSION_ACTION_COORDINATOR_ANSWERS_ID:
        case SESSION_ACTION_COORDINATOR_STOP_ID:
            return itemId;
        default:
            return null;
    }
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
    onOpenFollowEditor?: SessionActionExecutionOperations['openFollowEditor'];
    sessionName: string;
    hideInactiveSessions: boolean;
    iconColor: string;
    activeTags: readonly string[];
    knownTags: readonly string[];
    tagsEnabled: boolean;
    onSetTags?: ((newTags: string[]) => void) | null;
    onTogglePinned?: (() => void) | null;
    leadingMenuItems?: readonly DropdownMenuItem[];
    trailingMenuItems?: readonly DropdownMenuItem[];
    onSelectLeadingMenuItem?: (itemId: string) => boolean | Promise<boolean>;
    /** The Bots roster's compact menu instead of the list's; its Open row runs `onOpen`. */
    surface?: 'rowMenu' | 'botsRoster';
    /** The row's picture: an accepted Pin to rail travels from here to its rail slot (lab `b-rail`). */
    flightOriginRef?: React.RefObject<View | null>;
    onOpen?: () => void;
    onMoveToFolder?: () => void;
    /** Move to section's choices and chooser; the choices are read only while a menu is open. */
    sectionMove?: SessionRowSectionMove;
    spaceMembership?: SessionRowSpaceMembership;
    menuOpen?: boolean;
    selectionModeAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    touchPrimaryPointer: boolean;
    setContextMenuOpen: (open: boolean) => void;
    openTagsMenuFromContext: () => void;
    reminder?: SessionReminderPresentation | null;
    /** The session's own colour menu; null hides it (server without session appearances). */
    appearance?: (SessionAppearanceColorMenuInput & Readonly<{
        onChange: (color: SessionAppearanceColor | null) => void;
    }>) | null;
    /** Closes this row's open menus (an item that kept them open while it loaded is ready). */
    closeMenus?: () => void;
}>): SessionRowActionMenuState {
    const target = params.target;
    const spaceMembershipMenu = React.useMemo(
        () => params.menuOpen && params.surface !== 'botsRoster' ? params.spaceMembership?.readMenu(params.iconColor) ?? null : null,
        [params.iconColor, params.menuOpen, params.spaceMembership, params.surface],
    );
    const [customColorPickerLoading, setCustomColorPickerLoading] = React.useState(false);
    const appearanceMenu = React.useMemo(
        () => (params.appearance ? { ...params.appearance, customPickerLoading: customColorPickerLoading } : null),
        [customColorPickerLoading, params.appearance],
    );
    const pluginActions = useSessionRowPluginActions({ serverId: target.serverId, sessionId: target.sessionId,
        open: params.menuOpen === true });
    const archivePending = useSessionArchivePending(normalizeSessionAddress(target.serverId, target.sessionId));
    const [reminderPresets] = useSettingMutable('sessionReminderPresetsV1');
    const applyReminderPresetIntent = useApplySessionReminderPresetIntent();
    const applyTagToggle = React.useCallback((tagId: string) => {
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

    const applyTagCreate = React.useCallback((query: string) => {
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
    const tagMenuContent = React.useMemo(() => buildSessionTagsMenuContent({
        tags: params.knownTags.map((tag) => ({ id: tag, label: tag })),
        selectedTagIds: params.activeTags,
        iconColor: params.iconColor,
        onToggle: applyTagToggle,
        onCreate: applyTagCreate,
    }), [applyTagCreate, applyTagToggle, params.activeTags, params.iconColor, params.knownTags]);
    const tagMenuItems = tagMenuContent.dropdownItems;
    const handleTagMenuSelect = tagMenuContent.dropdownOnSelect;
    const handleTagMenuCreate = tagMenuContent.dropdownOnCreate ?? (() => {});

    const [stoppingSession, performStopMutation] = useHappyAction(async () => {
        await executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target,
            context: { hideInactiveSessions: params.hideInactiveSessions },
        });
    });

    const alsoArchiveReportsRef = React.useRef(false);
    const [archivingSession, performArchiveMutation] = useHappyAction(async () => {
        const context = { hideInactiveSessions: params.hideInactiveSessions };
        const alsoArchiveReports = alsoArchiveReportsRef.current;
        alsoArchiveReportsRef.current = false;
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target,
            input: { alsoArchiveReports },
            context,
        });
    });

    const confirmArchiveSession = React.useCallback(async () => {
        const confirmation = await confirmSessionArchive({ leadSessionId: target.sessionId, serverId: target.serverId });
        if (!confirmation.confirmed) return;
        alsoArchiveReportsRef.current = confirmation.alsoArchiveReports;
        performArchiveMutation();
    }, [performArchiveMutation, target.serverId, target.sessionId]);

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

    const handleUnarchiveSession = React.useCallback(async () => {
        try {
            await executeSessionAction({
                actionId: SESSION_ACTION_UNARCHIVE_ID,
                target,
            });
        } catch (error) {
            showActionError(error);
        }
    }, [target]);

    const [deletingSession, performDeleteMutation] = useHappyAction(async (deleteTarget: SessionActionTarget) => {
        await executeSessionAction({
            actionId: SESSION_ACTION_DELETE_ID,
            target: deleteTarget,
            context: { confirmed: true },
        });
    });
    const handleDeleteSession = React.useCallback(async () => {
        const deleteTarget = target;
        try {
            const confirmed = await confirmSessionDelete({ target: deleteTarget });
            if (confirmed) await performDeleteMutation(deleteTarget);
        } catch (error) {
            showActionError(error);
        }
    }, [performDeleteMutation, target]);

    const moreMenuItems = React.useMemo(() => {
        const selectItem = (
            !params.touchPrimaryPointer
            && params.selectionModeAvailable === true
            && params.selectionModeActive !== true
            && typeof params.onEnterSelectionMode === 'function'
        )
            ? [{
                id: SESSION_ROW_ACTION_SELECT_ID,
                title: t('sessionsList.selectionSelectAction'),
                icon: <Icon name="check-circle" size={16} color={params.iconColor} />,
            }]
            : [];
        if (params.surface === 'botsRoster') {
            return [...pluginActions.items,
                ...buildSessionRowMoreMenuItems({ target, iconColor: params.iconColor, surface: 'botsRoster', archivePending })];
        }
        return buildSessionRowMoreMenuItems({
            target,
            archivePending,
            iconColor: params.iconColor,
            leadingItems: [
                ...selectItem,
                ...(params.leadingMenuItems ?? []),
                ...pluginActions.items,
            ],
            trailingItems: params.trailingMenuItems,
            canMoveToFolder: typeof params.onMoveToFolder === 'function',
            sectionMoveItems: params.menuOpen ? params.sectionMove?.readMenuItems(params.iconColor) ?? null : null,
            spaceMembershipMenu,
            reminderPresets,
            reminder: params.reminder,
            reminderNowMs: Date.now(),
            appearance: appearanceMenu,
        });
    }, [
        appearanceMenu,
        spaceMembershipMenu,
        archivePending,
        pluginActions.items,
        params.iconColor,
        params.touchPrimaryPointer,
        params.leadingMenuItems,
        params.trailingMenuItems,
        params.onEnterSelectionMode,
        params.onMoveToFolder,
        params.sectionMove,
        params.menuOpen,
        params.selectionModeActive,
        params.selectionModeAvailable,
        params.surface,
        reminderPresets,
        params.reminder,
        target,
    ]);

    const handleMoreMenuSelect = React.useCallback(async (itemId: string, selection?: DropdownMenuSelection) => {
        const membershipChoice = spaceMembershipMenu?.choices.get(itemId);
        if (membershipChoice) {
            spaceMembershipMenu?.choose(membershipChoice);
            return;
        }
        // Invoke the registered owner in the gesture, before unrelated async admission.
        if ((findMenuItem(params.leadingMenuItems ?? [], itemId) || findMenuItem(params.trailingMenuItems ?? [], itemId))
            && await params.onSelectLeadingMenuItem?.(itemId)) return;
        if (await pluginActions.select(itemId, selection)) return;
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
        if (isSessionReminderMenuItemId(itemId)) {
            await handleSessionReminderMenuSelection({
                itemId,
                canSchedule: target.reminderAction.canSchedule,
                canClear: target.reminderAction.canClear,
                presets: reminderPresets ?? [],
                applyPresetIntent: applyReminderPresetIntent,
                schedule: async (remindAt) => await sessionSetAttentionReminderWithServerScope(
                    target.sessionId,
                    remindAt,
                    { serverId: target.serverId },
                ),
                clear: async () => await sessionClearAttentionReminderWithServerScope(target.sessionId, { serverId: target.serverId }),
            });
            return;
        }
        if (itemId === 'ui.session.follow') {
            await executeSessionAction({
                actionId: 'ui.session.follow',
                target,
                context: { operations: { openFollowEditor: params.onOpenFollowEditor } },
            });
            return;
        }
        if (itemId === SESSION_ROW_ACTION_SELECT_ID) {
            params.onEnterSelectionMode?.();
            return;
        }
        if (itemId === SESSION_ROW_ACTION_OPEN_ID) {
            params.onOpen?.();
            return;
        }
        const sectionChoice = readSessionSectionMoveMenuChoice(itemId);
        if (sectionChoice) {
            params.sectionMove?.choose(sectionChoice);
            return;
        }
        if (itemId === SESSION_ACTION_MOVE_TO_FOLDER_ID) {
            await executeLocalSessionAction({
                target,
                actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
                onMoveToFolder: params.onMoveToFolder,
            });
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

        const actionId = resolveActionIdFromMenuItemId(itemId);
        if (actionId === SESSION_ACTION_RAIL_PIN_ID) {
            // Where the picture is now; the rail slot reads it only if the pin is accepted.
            const pinned = { serverId: target.serverId, sessionId: target.sessionId };
            noteRailPinOrigin(pinned, await measureWindowRect(params.flightOriginRef?.current));
            await executeSessionAction({ actionId, target }).catch((error: unknown) => {
                forgetRailPinOrigin(pinned);
                showActionError(error);
            });
            return;
        }
        switch (actionId) {
            case SESSION_ACTION_RENAME_ID:
                await handleRenameSession();
                return;
            case SESSION_ACTION_STOP_ID:
                performStopMutation();
                return;
            case SESSION_ACTION_ARCHIVE_ID:
                await confirmArchiveSession();
                return;
            case SESSION_ACTION_UNARCHIVE_ID:
                await handleUnarchiveSession();
                return;
            case SESSION_ACTION_DELETE_ID:
                await handleDeleteSession();
                return;
            case SESSION_ACTION_WORK_OPEN_ID:
            case SESSION_ACTION_TALK_ID:
            case SESSION_ACTION_PUT_UNDER_ID:
            case SESSION_ACTION_RAIL_UNPIN_ID:
            case SESSION_ACTION_MAKE_BOT_ID:
            case SESSION_ACTION_MAKE_REGULAR_ID:
            case SESSION_ACTION_TOOL_CALLS_TOGGLE_ID:
            case SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID:
            case SESSION_ACTION_COORDINATOR_MAKE_ID:
            case SESSION_ACTION_COORDINATOR_EDIT_ID:
            case SESSION_ACTION_COORDINATOR_ANSWERS_ID:
            case SESSION_ACTION_COORDINATOR_STOP_ID:
                await executeSessionAction({ actionId, target }).catch(showActionError);
                return;
            default:
                return;
        }
    }, [
        spaceMembershipMenu,
        params.appearance,
        confirmArchiveSession,
        pluginActions.select,
        performStopMutation,
        handleAttentionStandingAction,
        handleReadStateAction,
        handleRenameSession,
        handleUnarchiveSession,
        handleDeleteSession,
        target,
        params.onEnterSelectionMode,
        params.onOpen,
        params.onOpenFollowEditor,
        params.onMoveToFolder,
        params.sectionMove,
        params.onSelectLeadingMenuItem,
        params.leadingMenuItems,
        params.trailingMenuItems,
        params.flightOriginRef,
        reminderPresets,
        applyReminderPresetIntent,
    ]);

    const contextMenuItems = React.useMemo((): DropdownMenuItem[] => {
        if (!params.touchPrimaryPointer) return [];
        const items: DropdownMenuItem[] = [];
        if (params.selectionModeAvailable === true && typeof params.onEnterSelectionMode === 'function') {
            items.push({
                id: SESSION_ROW_ACTION_SELECT_ID,
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
        params.touchPrimaryPointer,
        params.onEnterSelectionMode,
        params.onSetTags,
        params.onTogglePinned,
        params.selectionModeAvailable,
        params.tagsEnabled,
        target.isPinned,
    ]);

    const handleContextMenuSelect = React.useCallback((itemId: string, selection?: DropdownMenuSelection) => {
        if (itemId === SESSION_ROW_ACTION_SELECT_ID) {
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
            void handleMoreMenuSelect(itemId, selection);
            return;
        }
        params.setContextMenuOpen(false);
        void handleMoreMenuSelect(itemId, selection);
    }, [contextMenuItems, handleMoreMenuSelect, params, target]);

    return {
        tagMenuItems,
        handleTagMenuSelect,
        handleTagMenuCreate,
        moreMenuItems,
        handleMoreMenuSelect,
        contextMenuItems,
        handleContextMenuSelect,
        mutatingSession: stoppingSession || archivingSession || deletingSession || archivePending,
    };
}
