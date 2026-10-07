import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { HAPPIER_META_COLUMN_STYLE } from '@happier-dev/plugin-ui/presentation';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import React from 'react';
import {
    Animated,
    Platform,
    Pressable,
    View,
    type GestureResponderEvent,
    type LayoutChangeEvent,
} from 'react-native';
import {
    GestureDetector,
    Swipeable,
    type ComposedGesture,
    type GestureType,
} from 'react-native-gesture-handler';
import {
    StyleSheet,
    useUnistyles,
} from 'react-native-unistyles';

import {
    Text,
    Text as RNText,
} from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import {
    getAgentCore,
    } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { Typography } from '@/constants/Typography';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { sessionWorkStatusFactsFromStatus } from '@/components/work/status/sessionWorkStatusFacts';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { formatPendingCountBadge } from '@/components/sessions/pendingBadge';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useWorkspaceOpenActions } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { t } from '@/text';
import {
    resolveSessionListAttentionState,
    type SessionListSecondaryLineMode,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionName, getSessionSubtitle, getSessionStatus, resolveLockedSessionTitle, type SessionStatus } from '@/utils/sessions/sessionUtils';
import { PinIcon, PinSlashIcon } from './sessionPinIcons';
import { TagIcon } from './sessionTagIcons';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import {
    resolveSessionRowAttentionState,
    resolveSessionRowPresentation,
} from './row/resolveSessionRowPresentation';
import {
    normalizeSessionListActiveColorMode,
    resolveSessionRowTitleColorRole,
} from './row/sessionRowTitleColorRole';
import { SessionRowAttentionIndicator } from './row/SessionRowAttentionIndicator';
import { SessionRowReportsChip, hasSessionRowReportsChip } from './row/SessionRowReportsChip';
import { SessionListRowPresentation, SessionListRowSubtitle, SessionListRowTitle } from './row/SessionListRowPresentation';
import { WorkflowRunItemBody, type WorkflowRunItemProps } from './row/WorkflowRunItemBody';
import {
    SESSION_LIST_ROW_CORNER_RADIUS,
    resolveSessionListRowIdentityMetrics,
    SESSION_LIST_ROW_IDENTITY_METRICS,
    SESSION_LIST_ROW_STATUS_TEXT_METRICS,
} from './resolveSessionListDensityViewState';
import { resolveSessionRowInteractionPolicy } from './row/resolveSessionRowInteractionPolicy';
import { SESSION_LIST_SHEET_INSET_PX } from './sessionListStyles';
import { resolveSessionItemTagCollections } from './sessionTagUtils';
import { planSessionTagDisplay } from './sessionTagPlacement';
import { useSessionSplitCanvasRowActionsForScope } from '@/components/sessions/canvas/useSessionSplitCanvasRowActions';
import { EntityDragGrip } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { resolveSessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';
import { useIsTablet } from '@/utils/platform/responsive';
import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_UNPIN_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { SessionListSelectionCheckbox } from './selection/SessionListSelectionCheckbox';
import { useOptionalSessionListSelectionRow } from './selection/SessionListSelectionContext';
import { resolveSessionListSelectionPointerAction } from './selection/sessionListSelectionPointer';
import { useSessionRowActionMenu } from './row/actionMenu/useSessionRowActionMenu';
import { formatSessionAttentionReminderDateTime } from './row/actionMenu/sessionAttentionReminderAction';
import {
    SESSION_ROW_ACTION_OPEN_SPLIT_DOWN_ID,
    SESSION_ROW_ACTION_OPEN_SPLIT_RIGHT_ID,
    SESSION_ROW_ACTION_REVEAL_IN_CURRENT_SPLIT_ID,
} from './row/actionMenu/sessionRowActionMenuTypes';
import {
    buildSessionDebugInformation,
    isSessionDebugInformationEnabled,
    resolveProviderSessionIdForDebug,
} from '@/components/sessions/debug/sessionDebugInformation';
import { copySessionDebugInformationToClipboard } from '@/components/sessions/debug/sessionDebugClipboard';
import {
    createCopySessionDebugInformationMenuItem,
    SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID,
} from '@/components/sessions/debug/sessionDebugMenuItem';
import {
    storage,
    useLocalSetting,
} from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import type { ExternalSessionIdentityPresentation } from '../presentation/externalSessionIdentityPresentation';
import {
    normalizeSessionListIdentityDisplay,
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from './SessionListIdentity';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveMachineTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { selectSessionViewShellSessionForRouteState } from './sessionViewStableSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { SessionForkReplaySettingsSource } from '@/sync/domains/sessionFork/resolveSessionForkReplayOptions';

const SESSION_ROW_ORGANIZE_LIST_MENU_ITEM_ID = 'session.organizeList';

const CONTEXT_MENU_PRESS_IN_OPEN_DELAY_MS = 350;
const CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS = 600;
const SESSION_IDENTITY_SKELETON_ANIMATION_MS = 900;
const SESSION_FOLDER_ROW_CHROME_INDENT_BASE = 38;
const SESSION_FOLDER_ROW_CHROME_INDENT_STEP = 12;
const SESSION_REPORTS_ROW_INDENT_STEP = 22;
const SESSION_FOLDER_MOVE_MENU_INDENT_BASE = 16;
const SESSION_FOLDER_MOVE_MENU_INDENT_STEP = 12;
const SESSION_DELETE_DRAFT_MENU_ITEM_ID = 'session-draft.delete';

let sessionForkStrategyFlowModulePromise:
    Promise<typeof import('@/components/sessions/fork/openSessionForkStrategyFlow')> | null = null;

function loadSessionForkStrategyFlowModule() {
    if (!sessionForkStrategyFlowModulePromise) {
        sessionForkStrategyFlowModulePromise = import(
            '@/components/sessions/fork/openSessionForkStrategyFlow'
        ).catch((error: unknown) => {
            sessionForkStrategyFlowModulePromise = null;
            throw error;
        });
    }
    return sessionForkStrategyFlowModulePromise;
}

function preloadSessionForkStrategyFlowModule(): void {
    void loadSessionForkStrategyFlowModule().catch(() => undefined);
}

/**
 * `storage.sessions` is the hydrated entity owner for the focused Home only. A
 * row addressed to another Home shares its Session ID space, so it must not
 * borrow the focused Home's same-ID entity for Fork or debug metadata. The
 * canonical route-state selector already fails closed on that mismatch; an
 * unqualified row keeps its current unscoped behavior.
 */
function readHydratedSessionForRow(sessionId: string, serverId: string | null | undefined): Session | null {
    return selectSessionViewShellSessionForRouteState(storage.getState(), sessionId, serverId ?? null);
}

type SessionItemWorkingIndicatorMode = 'spinner' | 'pulse';
type SessionItemActiveColorMode = 'activityAndAttention' | 'attentionOnly' | 'allActive';

export type SessionItemBaseProps = Readonly<{
    embedded?: boolean;
    embeddedIsLast?: boolean;
    session: Session | SessionListRenderableSession;
    subtitleOverride?: string | null;
    subtitleEllipsizeMode?: 'head' | 'tail';
    serverId?: string;
    serverName?: string;
    currentUserId?: string | null;
    showServerBadge?: boolean;
    pinned?: boolean;
    onTogglePinned?: (() => void) | null;
    tags?: string[];
    allKnownTags?: string[];
    onSetTags?: ((newTags: string[]) => void) | null;
    tagsEnabled?: boolean;
    selectionKey?: string | null;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    variant?: 'default' | 'no-path';
    secondaryLineMode?: SessionListSecondaryLineMode;
    compact?: boolean;
    compactMinimal?: boolean;
    folderDepth?: number;
    /** Level under a lead in the `reportsTo` tree (ORC §3.8); 0 or absent draws the row at its own level. */
    reportsDepth?: number;
    folderMoveTargets?: readonly SessionFolderMoveTarget[];
    onMoveToSessionFolder?: (folderId: string | null) => void | Promise<void>;
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onDeleteDraft?: () => void | Promise<void>;
    /** Phone Organize mode: the grip's drag gesture (K1). Desktop rows carry the whole row instead. */
    dragGripGesture?: GestureType | ComposedGesture;
    isBeingDragged?: boolean;
    /** The row can be carried at all (the list's organization and order rules allow it). */
    dragEnabled?: boolean;
    /** The phone list is in its Organize mode, so the row shows its grip instead of swipe/long-press. */
    organizeMode?: boolean;
    nativeContextMenuOpen?: boolean;
    onNativeContextMenuOpenChange?: (next: boolean) => void;
    rowAttentionAnimationEnabled?: boolean;
    agentSwitchingEnabled?: boolean;
    forkActionContext?: Readonly<{
        settings: SessionForkReplaySettingsSource | null;
        replayEnabled: boolean;
        executionRunsEnabled: boolean;
    }>;
}>;

export type SessionItemProps = SessionItemBaseProps & Readonly<{
    rowViewModel: SessionListRowViewModel;
    hideInactiveSessions?: boolean;
}>;

type SessionItemContentProps = Omit<SessionItemBaseProps, 'subtitleOverride'> & Readonly<{
    sessionStatus: SessionStatus;
    externalSessionIdentity: ExternalSessionIdentityPresentation | null;
    sessionNameResolved: string;
    sessionSubtitle: string;
    isSessionIdentityLoading: boolean;
    activityTimeLabel: string;
    hasUnreadMessages: boolean;
    workingIndicatorMode: SessionItemWorkingIndicatorMode;
    /**
     * The row is in Needs attention only because the user asked for it. It says
     * why the row is still there and must not colour the title or the badge the
     * way an unread session does.
     */
    attentionStanding?: boolean;
    /**
     * The STORED standing bit, not the placement outcome above. The row action
     * menu must offer Remove for a session the user kept even while it is
     * currently placed for a stronger reason, so the action target reads this
     * and never `attentionStanding`.
     */
    isAttentionStanding?: boolean;
    /** Whether the Keep / Remove action means anything at all (attention band on). */
    attentionStandingEnabled?: boolean;
    rowAttentionAnimationEnabled: boolean;
    sessionListIdentityDisplay: SessionListIdentityDisplay;
    sessionListActiveColorMode: SessionItemActiveColorMode;
    hideInactiveSessions: boolean;
    draft: SessionListRowViewModel['draft'];
    reminder: SessionListRowViewModel['reminder'];
}>;

function normalizeSessionItemActiveColorMode(value: unknown): SessionItemActiveColorMode {
    return value === 'attentionOnly' || value === 'allActive' ? value : 'activityAndAttention';
}

function hasPendingUserActionRequests(session: Session | SessionListRenderableSession): boolean {
    return 'hasPendingUserActionRequests' in session && session.hasPendingUserActionRequests === true;
}

function hasPendingPermissionRequests(session: Session | SessionListRenderableSession): boolean {
    return 'hasPendingPermissionRequests' in session && session.hasPendingPermissionRequests === true;
}

function normalizeFiniteCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function mergePendingBlockedCount<T extends Session | SessionListRenderableSession>(
    session: T,
    pendingBlockedCount: number | null,
): T {
    if (pendingBlockedCount === null) return session;
    if (normalizeFiniteCount(session.pendingBlockedCount) === pendingBlockedCount) return session;
    return {
        ...session,
        pendingBlockedCount,
    };
}

function resolveSessionItemEffectiveSession(input: Readonly<{
    rowSession: SessionListRenderableSession;
    providedSession: Session | SessionListRenderableSession;
}>): Session | SessionListRenderableSession {
    if (input.providedSession.id !== input.rowSession.id) {
        return input.rowSession;
    }
    const providedBlockedCount = normalizeFiniteCount(input.providedSession.pendingBlockedCount);
    const rowBlockedCount = normalizeFiniteCount(input.rowSession.pendingBlockedCount);
    const pendingBlockedCount = providedBlockedCount ?? rowBlockedCount;
    if (
        hasPendingUserActionRequests(input.providedSession)
        && !hasPendingUserActionRequests(input.rowSession)
    ) {
        return mergePendingBlockedCount(input.providedSession, pendingBlockedCount);
    }
    if (
        hasPendingPermissionRequests(input.providedSession)
        && !hasPendingPermissionRequests(input.rowSession)
    ) {
        return mergePendingBlockedCount(input.providedSession, pendingBlockedCount);
    }
    return mergePendingBlockedCount(input.rowSession, pendingBlockedCount);
}

function resolveSessionFolderMoveTargetRowContainerStyle(depth: number) {
    const normalizedDepth = Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0));
    if (normalizedDepth === 0) return undefined;
    return { paddingLeft: SESSION_FOLDER_MOVE_MENU_INDENT_BASE + normalizedDepth * SESSION_FOLDER_MOVE_MENU_INDENT_STEP };
}

function resolveSessionFolderMoveTargetTestId(target: SessionFolderMoveTarget): string {
    return `dropdown-option-move-to-folder_${target.folderId ?? 'null'}`;
}

const stylesheet = StyleSheet.create((theme) => ({
    // Each group is one sheet (S1 Grouped): the rows are its slices, so a slice draws the sheet's
    // paper and hairline on its own edges (the sides always, the top on the first row, the bottom on
    // the last) and the group reads as one rounded object on the list's tinted plane.
    sessionItemContainer: {
        // The column's sheet edge (the shared column frame), where the Drafts sheet and the Browse row start too.
        marginHorizontal: SESSION_LIST_SHEET_INSET_PX,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.surface,
    },
    sessionItemContainerEmbedded: {
        marginHorizontal: 0,
        marginBottom: 0,
        overflow: 'hidden',
    },
    sessionItemContainerFirst: {
        borderTopLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomWidth: StyleSheet.hairlineWidth,
        marginBottom: 12,
    },
    sessionItemContainerSingle: {
        borderRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        marginBottom: 12,
    },
    avatarLoading: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
    },
    avatarLoadingCompact: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
    },
    avatarLoadingMinimal: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
    },
    avatarLoadingMinimalNativePhone: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
    },
    pendingCountContainer: {
        position: 'absolute',
        top: -4,
        right: -3,
        minWidth: 15,
        height: 15,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.background?.canvas ?? 'transparent',
    },
    pendingCountContainerCompact: {
        top: -3,
        right: -3,
        minWidth: 14,
        height: 14,
    },
    pendingCountText: {
        fontSize: 8,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconContainerCompact: {
        width: 16,
        height: 16,
        bottom: -1,
        right: -1,
    },
    reminderIndicator: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    reminderIndicatorCompact: {
        width: 18,
        height: 18,
    },
    sessionTitleLoading: {
        width: '68%',
        height: 14,
        borderRadius: 7,
        backgroundColor: theme.colors.surface.elevated,
    },
    sessionTitleLoadingCompact: {
        width: '60%',
        height: 13,
        borderRadius: 7,
        backgroundColor: theme.colors.surface.elevated,
    },
    sessionTitleLoadingMinimal: {
        width: '56%',
        height: 12,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.elevated,
    },
    sessionSubtitleLoading: {
        width: '46%',
        height: 10,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
        marginTop: 3,
    },
    sessionSubtitleLoadingCompact: {
        width: '42%',
        height: 9,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
        marginTop: 2,
    },
    serverBadgeContainer: {
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.background.canvas,
        maxWidth: 140,
    },
    serverBadgeText: {
        fontSize: 10,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    // The `reportsTo` tree: a report sits one step in, joined to its lead by a hairline elbow.
    reportsGutter: {
        alignSelf: 'stretch',
        alignItems: 'flex-end',
    },
    reportsConnector: {
        width: 10,
        height: '50%',
        marginRight: 6,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomLeftRadius: 6,
        borderColor: theme.colors.border.default,
    },
    trailingMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 2,
    },
    rowActionsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    rowActionButton: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
    },
    rowActionIcon: {
        color: theme.colors.text.secondary,
    },
    tagsRow: {
        flexDirection: 'row',
        flexWrap: 'nowrap',
        overflow: 'hidden',
        gap: 4,
        marginTop: 3,
    },
    tagsRowCompact: {
        marginTop: 1,
    },
    tagsRowMinimal: {
        marginTop: 0,
    },
    tagsInlineRow: {
        alignItems: 'center',
        marginTop: 0,
        marginRight: 4,
        maxWidth: 82,
    },
    tagChip: {
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.background.canvas,
        maxWidth: 120,
    },
    tagChipCompact: {
        paddingHorizontal: 6,
        paddingVertical: 1,
        maxWidth: 110,
    },
    tagChipMinimal: {
        paddingHorizontal: 6,
        paddingVertical: 1,
        maxWidth: 96,
    },
    tagChipInline: {
        maxWidth: 74,
    },
    tagChipText: {
        fontSize: 10,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    tagChipTextCompact: {
        fontSize: 9,
    },
    tagChipTextMinimal: {
        fontSize: 9,
    },
    tagChipInlineText: {
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.background.canvas,
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
        marginLeft: 8,
        overflow: 'hidden',
    },
    sessionPathSubtitleWeb: {
        ...WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    },
    sessionPathSubtitleTextWeb: {
        ...WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
    },
    secondaryLineRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 16,
        gap: 4,
    },
    secondaryLineRowMinimal: {
        minHeight: 12,
        gap: 3,
        marginTop: -1,
    },
    // As wide as the attention indicator's own slot, so the 16 px working spinner keeps the line's
    // gap to the status text instead of overhanging it.
    secondaryStatusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 12,
    },
    secondaryStatusDotContainerMinimal: {
        width: 10,
        height: 12,
    },
    statusText: {
        ...SESSION_LIST_ROW_STATUS_TEXT_METRICS.default,
        ...Typography.default(),
    },
    statusTextCompact: {
        ...SESSION_LIST_ROW_STATUS_TEXT_METRICS.compact,
    },
    statusTextQuiet: {
        color: theme.colors.text.secondary,
    },
    statusTextMinimal: {
        ...SESSION_LIST_ROW_STATUS_TEXT_METRICS.minimal,
    },
    // The row's meta: the shared right-aligned tabular column, so times scan down the list.
    activityTime: {
        fontSize: 10,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        ...HAPPIER_META_COLUMN_STYLE,
    },
    activityTimeMinimal: {
        fontSize: 10,
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: theme.colors.button.primary.tint,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
}));

const SessionItemContent = React.memo(
    ({
        embedded,
        embeddedIsLast,
        session,
        subtitleEllipsizeMode,
        serverId,
        serverName,
        currentUserId,
        showServerBadge,
        pinned,
        onTogglePinned,
        tags,
        allKnownTags,
        onSetTags,
        tagsEnabled,
        selectionKey,
        selected,
        isFirst,
        isLast,
        isSingle,
        variant,
        secondaryLineMode,
        compact,
        compactMinimal,
        folderDepth,
        reportsDepth,
        folderMoveTargets,
        onMoveToSessionFolder,
        onMoveToFolder,
        onMoveToWorkspaceRoot,
        onMoveUp,
        onMoveDown,
        onDeleteDraft,
        dragGripGesture,
        isBeingDragged,
        dragEnabled = false,
        organizeMode = false,
        nativeContextMenuOpen,
        onNativeContextMenuOpenChange,
        agentSwitchingEnabled = false,
        forkActionContext,
        sessionStatus,
        externalSessionIdentity,
        sessionNameResolved,
        sessionSubtitle,
        isSessionIdentityLoading,
        activityTimeLabel,
        hasUnreadMessages,
        workingIndicatorMode,
        attentionStanding,
        isAttentionStanding,
        attentionStandingEnabled,
        rowAttentionAnimationEnabled,
        sessionListIdentityDisplay,
        sessionListActiveColorMode,
        hideInactiveSessions,
        draft,
        reminder,
    }: SessionItemContentProps) => {
        const router = useDestinationRouter();
        const styles = stylesheet;
        const { theme } = useUnistyles();
        const localDevModeEnabled = useLocalSetting('devModeEnabled');
        const uiFontScale = useLocalSetting('uiFontScale');
        const devModeEnabled = isSessionDebugInformationEnabled(localDevModeEnabled);
        const resolvedSession = session;
        const sessionId = String(resolvedSession?.id ?? '').trim();
        const resolvedSessionMetadata = React.useMemo(
            () => 'agentState' in resolvedSession
                ? readSessionOwnerMetadataView(resolvedSession)
                : resolvedSession.metadata,
            [resolvedSession],
        );
        // Null means the row's Agent is genuinely unknown. The avatar and logo
        // both degrade to their neutral mark; painting the default Agent's brand
        // on someone else's Session is a lie, not a fallback.
        const agentId = React.useMemo(
            () => (
                'agentState' in resolvedSession
                    ? readSessionPresentationAgentId(resolvedSession)
                    : resolveAgentIdFromSessionMetadata(resolvedSessionMetadata)
            ),
            [resolvedSession, resolvedSessionMetadata],
        );
        const resolvedSelectionKey = selectionKey ?? '';
        const rowSelection = useOptionalSessionListSelectionRow(resolvedSelectionKey);
        const identitySkeletonOpacity = React.useRef(new Animated.Value(0.45)).current;
        React.useEffect(() => {
            if (!isSessionIdentityLoading) return;
            if (!rowAttentionAnimationEnabled) return;
            if (typeof Animated.loop !== 'function' || typeof Animated.sequence !== 'function') return;

            const animation = Animated.loop(
                Animated.sequence([
                    Animated.timing(identitySkeletonOpacity, {
                        toValue: 1,
                        duration: SESSION_IDENTITY_SKELETON_ANIMATION_MS,
                        useNativeDriver: true,
                    }),
                    Animated.timing(identitySkeletonOpacity, {
                        toValue: 0.45,
                        duration: SESSION_IDENTITY_SKELETON_ANIMATION_MS,
                        useNativeDriver: true,
                    }),
                ]),
            );
            animation.start();
            return () => {
                animation.stop();
            };
        }, [isSessionIdentityLoading, identitySkeletonOpacity, rowAttentionAnimationEnabled]);
        const navigateToSession = useNavigateToSession();
        // Open in a kept tab or beside the focused pane, through the workspace owner (workspace lab O).
        const workspaceOpen = useWorkspaceOpenActions(buildScopedSessionRouteHref({
            sessionId: resolvedSession.id,
            serverId: serverId ?? null,
        }));
        const splitCanvasScope = React.useMemo(() => {
            return resolveSessionSplitCanvasScope(resolveWorkspaceTargetForSession(sessionId), {
                routeServerId: serverId ?? null,
            });
        }, [serverId, sessionId]);
        const splitCanvasRowActions = useSessionSplitCanvasRowActionsForScope({
            sessionId: resolvedSession.id,
            scope: splitCanvasScope,
        });
        const swipeableRef = React.useRef<Swipeable | null>(null);
        const contextMenuAnchorRef = React.useRef<View>(null);
        const followEditor = useAccountSessionFollowEditorHost({
            serverId: serverId ?? null,
            sessionId: resolvedSession.id,
            anchorRef: contextMenuAnchorRef,
        });
        const sessionActionTarget = React.useMemo(() => createSessionActionTarget({
            session: resolvedSession,
            serverId: serverId ?? null,
            currentUserId: currentUserId ?? null,
            isConnected: sessionStatus.isConnected,
            isPinned: Boolean(pinned),
            attentionStandingEnabled: attentionStandingEnabled === true,
            followEnabled: followEditor.enabled,
            attentionStanding: isAttentionStanding === true,
        }), [
            attentionStandingEnabled,
            followEditor.enabled,
            currentUserId,
            isAttentionStanding,
            pinned,
            resolvedSession,
            serverId,
            sessionStatus.isConnected,
        ]);
        const isActiveSession = sessionActionTarget.isActive;
        const isMinimal = Boolean(compact && compactMinimal);
        const canStopSession = sessionActionTarget.canStop;
        const canArchiveSession = sessionActionTarget.canArchive;
        const [isRowHovered, setIsRowHovered] = React.useState(false);
        const [isActionsHovered, setIsActionsHovered] = React.useState(false);
        const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
        const [tagMenuEverOpened, setTagMenuEverOpened] = React.useState(false);
        const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
        const copyFeedback = useTemporaryCopyFeedback();
        const [rowWidth, setRowWidth] = React.useState<number | null>(null);
        const isWeb = Platform.OS === 'web';
        const isNativeMobile = Platform.OS === 'ios' || Platform.OS === 'android';
        const isTablet = useIsTablet();
        const useReadableNativePhoneMinimalRow = isMinimal && isNativeMobile && !isTablet;
        const showRowActions = isWeb && (isRowHovered || isActionsHovered || tagMenuOpen || moreMenuOpen || isBeingDragged === true);
        const rowActionIconColor = theme.colors.text.secondary;
        const resolveSessionDebugInformation = React.useCallback(() => {
            const fullSession = readHydratedSessionForRow(resolvedSession.id, serverId);
            const debugSession = fullSession ?? resolvedSession;
            const debugMetadata = fullSession
                ? readSessionOwnerMetadataView(fullSession)
                : readSessionMetadataLayoutVersion(resolvedSession.metadataLayoutVersion) === 0
                    ? resolvedSession.metadata
                    : null;
            const debugAgentId = resolveAgentIdFromSessionMetadata(debugMetadata) ?? '';
            const debugAgentCore = getAgentCore(debugAgentId);
            const providerSessionId = resolveProviderSessionIdForDebug({
                metadata: debugMetadata,
                vendorResumeIdField: debugAgentCore?.resume.vendorResumeIdField,
            });
            return buildSessionDebugInformation({
                session: debugSession,
                providerDisplayName: debugAgentCore
                    ? t(debugAgentCore.displayNameKey)
                    : formatAgentLikeIdForDisplay(debugAgentId),
                providerSessionId,
            });
        }, [resolvedSession, serverId]);
        const supportsPin = typeof onTogglePinned === 'function';
        const supportsTag = tagsEnabled === true && typeof onSetTags === 'function';
        const handleTogglePinnedAction = React.useCallback(() => {
            if (!onTogglePinned) return;
            void executeSessionAction({
                actionId: pinned ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID,
                target: sessionActionTarget,
                context: {
                    operations: {
                        setPinned: () => {
                            onTogglePinned();
                        },
                    },
                },
            });
        }, [onTogglePinned, pinned, sessionActionTarget]);
        const showTagAction = supportsTag && showRowActions;
        const { activeTags, knownTags } = React.useMemo(() => resolveSessionItemTagCollections({
            tags,
            allKnownTags,
        }), [allKnownTags, tags]);
        const [uncontrolledContextMenuOpen, setUncontrolledContextMenuOpen] = React.useState(false);
        const contextMenuOpen = nativeContextMenuOpen ?? uncontrolledContextMenuOpen;
        const setContextMenuOpen = onNativeContextMenuOpenChange ?? setUncontrolledContextMenuOpen;
        const suppressNextPressRef = React.useRef(false);
        const contextMenuWasOpenRef = React.useRef(false);
        const clearSuppressionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const contextMenuPressInTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const isBeingDraggedRef = React.useRef<boolean>(false);
        const suppressNextPressForPointerGesture = React.useCallback(() => {
            suppressNextPressRef.current = true;
            if (clearSuppressionTimeoutRef.current) {
                clearTimeout(clearSuppressionTimeoutRef.current);
            }
            clearSuppressionTimeoutRef.current = setTimeout(() => {
                suppressNextPressRef.current = false;
                clearSuppressionTimeoutRef.current = null;
            }, CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS);
        }, []);
        React.useEffect(() => () => {
            if (clearSuppressionTimeoutRef.current) {
                clearTimeout(clearSuppressionTimeoutRef.current);
                clearSuppressionTimeoutRef.current = null;
            }
        }, []);
        const clearContextMenuPressInTimer = React.useCallback(() => {
            if (!contextMenuPressInTimerRef.current) return;
            clearTimeout(contextMenuPressInTimerRef.current);
            contextMenuPressInTimerRef.current = null;
        }, []);
        React.useEffect(() => clearContextMenuPressInTimer, [clearContextMenuPressInTimer]);
        React.useEffect(() => {
            const wasBeingDragged = isBeingDraggedRef.current;
            const isReorderDragActive = isBeingDragged === true;
            isBeingDraggedRef.current = isReorderDragActive;
            // The whole desktop row is the drag source: the press that ends a carry must not also open it.
            if (Platform.OS === 'web' && dragEnabled && (isReorderDragActive || wasBeingDragged)) {
                suppressNextPressForPointerGesture();
            }
        }, [dragEnabled, isBeingDragged, suppressNextPressForPointerGesture]);
        const showForkAction = forkActionContext != null && canForkConversation({
            session: resolvedSession,
            replayEnabled: forkActionContext.replayEnabled,
            agentSwitchingEnabled,
        });
        const handleRowPointerEnter = React.useCallback(() => {
            if (showForkAction) {
                preloadSessionForkStrategyFlowModule();
            }
            setIsRowHovered(true);
        }, [showForkAction]);

        const handleRowPointerLeave = React.useCallback(() => {
            setIsRowHovered(false);
            setIsActionsHovered(false);
        }, []);

        const handleActionsHoverIn = React.useCallback(() => {
            setIsActionsHovered(true);
        }, []);

        const handleActionsHoverOut = React.useCallback(() => {
            setIsActionsHovered(false);
        }, []);

        const handleRowLayout = React.useCallback((event: LayoutChangeEvent) => {
            const nextWidth = event.nativeEvent.layout.width;
            setRowWidth((previousWidth) => {
                if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 1) {
                    return previousWidth;
                }
                return nextWidth;
            });
        }, []);

        const stopRowPressPropagation = React.useCallback((event: unknown) => {
            const e = event as any;
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
        }, []);

        const folderMoveMenuItems = React.useMemo((): DropdownMenuItem[] => (
            (folderMoveTargets ?? []).map((target): DropdownMenuItem => ({
                id: target.id,
                testID: resolveSessionFolderMoveTargetTestId(target),
                title: target.title,
                icon: target.folderId
                    ? <Icon name="folder" size={16} color={rowActionIconColor} />
                    : <Icon name="tray" size={16} color={rowActionIconColor} />,
                rowContainerStyle: resolveSessionFolderMoveTargetRowContainerStyle(target.depth),
                disabled: target.disabled,
            }))
        ), [folderMoveTargets, rowActionIconColor]);

        const splitCanvasMenuItems = React.useMemo((): DropdownMenuItem[] => {
            if (splitCanvasRowActions.mode === 'open') {
                return [
                    {
                        id: SESSION_ROW_ACTION_OPEN_SPLIT_RIGHT_ID,
                        title: t('sessionInfo.openInSplitRight'),
                        icon: <Icon name="arrow-right" size={16} color={rowActionIconColor} />,
                    },
                    {
                        id: SESSION_ROW_ACTION_OPEN_SPLIT_DOWN_ID,
                        title: t('sessionInfo.openInSplitDown'),
                        icon: <Icon name="arrow-down" size={16} color={rowActionIconColor} />,
                    },
                ];
            }
            if (splitCanvasRowActions.mode === 'reveal') {
                return [{
                    id: SESSION_ROW_ACTION_REVEAL_IN_CURRENT_SPLIT_ID,
                    title: t('sessionInfo.revealInCurrentSplit'),
                    icon: <Icon name="crosshair" size={16} color={rowActionIconColor} />,
                }];
            }
            return [];
        }, [rowActionIconColor, splitCanvasRowActions.mode]);
        const copyDebugMenuItems = React.useMemo((): DropdownMenuItem[] => {
            if (!devModeEnabled) return [];
            return [createCopySessionDebugInformationMenuItem({ iconColor: rowActionIconColor })];
        }, [devModeEnabled, rowActionIconColor]);
        const confirmDeleteDraft = React.useCallback(async () => {
            if (!draft || !onDeleteDraft) return;
            const confirmed = await Modal.confirm(
                t('sessionDrafts.delete.confirmTitle'),
                t('sessionDrafts.delete.confirmDescription'),
                {
                    confirmText: t('common.delete'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                },
            );
            if (!confirmed) return;
            try {
                await onDeleteDraft();
            } catch {
                Modal.alert(t('common.error'), t('errors.unknownError'));
            }
        }, [draft, onDeleteDraft]);
        const draftMenuItems = React.useMemo((): DropdownMenuItem[] => {
            if (!draft || !onDeleteDraft) return [];
            return [{
                id: SESSION_DELETE_DRAFT_MENU_ITEM_ID,
                testID: `session-draft-delete:existing-session:${resolvedSession.id}`,
                title: t('sessionDrafts.delete.action'),
                icon: <Icon name="trash" size={16} color={rowActionIconColor} />,
            }];
        }, [draft, onDeleteDraft, resolvedSession.id, rowActionIconColor]);
        const openForkFlow = React.useCallback(() => {
            fireAndForget((async () => {
                const { openSessionForkStrategyFlow } = await loadSessionForkStrategyFlowModule();
                const currentSession = readHydratedSessionForRow(resolvedSession.id, serverId) ?? resolvedSession;
                const currentMetadata = 'ownerMetadataView' in currentSession
                    ? readSessionOwnerMetadataView(currentSession)
                    : currentSession.metadata;
                const reachableMachineTarget = resolveMachineTargetForSessionFromState(
                    storage.getState(),
                    serverId ? { serverId, sessionId: resolvedSession.id } : resolvedSession.id,
                );
                openSessionForkStrategyFlow({
                    navigation: router,
                    sessionId: resolvedSession.id,
                    forkSupportSource: currentSession,
                    serverId: serverId ?? null,
                    machineId: reachableMachineTarget?.machineId ?? currentMetadata?.machineId ?? null,
                    forkPoint: { type: 'latest' },
                    settings: forkActionContext?.settings ?? null,
                    replayEnabled: forkActionContext?.replayEnabled === true,
                    executionRunsEnabled: forkActionContext?.executionRunsEnabled === true,
                    agentSwitchingEnabled,
                    navigateToSession: (childSessionId, options) => {
                        void navigateToSession(childSessionId, {
                            serverId: options?.serverId ?? serverId ?? undefined,
                        });
                    },
                    navigateToNewSession: (route) => {
                        router.push(route as never);
                    },
                });
            })(), { tag: 'SessionItem.openSessionForkStrategyFlow' });
        }, [
            agentSwitchingEnabled,
            forkActionContext,
            navigateToSession,
            router,
            resolvedSession,
            serverId,
        ]);
        const forkMenuItems = React.useMemo((): DropdownMenuItem[] => {
            if (!showForkAction) return [];
            return [{
                id: 'session.fork',
                title: t('sessionInfo.forkSession'),
                subtitle: undefined,
                icon: <Icon name="git-branch" size={16} color={rowActionIconColor} />,
            }];
        }, [rowActionIconColor, showForkAction]);
        // K1: on a phone the long-press menu is how a list enters Organize mode; it never lifts the row.
        const organize = useSessionListOrganizeMode();
        const organizeMenuItems = React.useMemo((): DropdownMenuItem[] => {
            if (!organize.available || organize.active || !dragEnabled) return [];
            return [{
                id: SESSION_ROW_ORGANIZE_LIST_MENU_ITEM_ID,
                title: t('entityDragDrop.organize.enter'),
                icon: <Icon name="dots-six-vertical" size={16} color={rowActionIconColor} />,
            }];
        }, [dragEnabled, organize.active, organize.available, rowActionIconColor]);
        const leadingMenuItems = React.useMemo(
            () => [...workspaceOpen.items, ...draftMenuItems, ...copyDebugMenuItems, ...forkMenuItems, ...splitCanvasMenuItems, ...organizeMenuItems],
            [copyDebugMenuItems, draftMenuItems, forkMenuItems, organizeMenuItems, splitCanvasMenuItems, workspaceOpen.items],
        );

        const handleSelectSplitCanvasMenuItem = React.useCallback((itemId: string): boolean => {
            switch (itemId) {
                case SESSION_ROW_ACTION_OPEN_SPLIT_RIGHT_ID:
                    splitCanvasRowActions.openInSplitRight();
                    return true;
                case SESSION_ROW_ACTION_OPEN_SPLIT_DOWN_ID:
                    splitCanvasRowActions.openInSplitDown();
                    return true;
                case SESSION_ROW_ACTION_REVEAL_IN_CURRENT_SPLIT_ID:
                    splitCanvasRowActions.revealInSplit();
                    return true;
                default:
                    return false;
            }
        }, [splitCanvasRowActions]);
        const handleSelectLeadingMenuItem = React.useCallback(async (itemId: string): Promise<boolean> => {
            if (workspaceOpen.select(itemId)) return true;
            if (itemId === SESSION_ROW_ORGANIZE_LIST_MENU_ITEM_ID) {
                organize.enter();
                return true;
            }
            if (itemId === SESSION_DELETE_DRAFT_MENU_ITEM_ID) {
                await confirmDeleteDraft();
                return true;
            }
            if (itemId === SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID) {
                const copied = await copySessionDebugInformationToClipboard(resolveSessionDebugInformation());
                if (copied) {
                    copyFeedback.markCopied(resolvedSession.id);
                }
                return true;
            }
            if (itemId === 'session.fork') {
                openForkFlow();
                return true;
            }
            return handleSelectSplitCanvasMenuItem(itemId);
        }, [confirmDeleteDraft, copyFeedback, handleSelectSplitCanvasMenuItem, openForkFlow, organize, resolvedSession.id, resolveSessionDebugInformation, workspaceOpen]);

        const handleSelectFolderMoveMenuItem = React.useCallback(async (itemId: string) => {
            if (itemId === 'session-folder-move-root') {
                await onMoveToSessionFolder?.(null);
                return;
            }
            const target = folderMoveTargets?.find((candidate) => candidate.id === itemId);
            if (target) {
                await onMoveToSessionFolder?.(target.folderId);
            }
        }, [folderMoveTargets, onMoveToSessionFolder]);

        const handleEnterSelectionMode = React.useCallback(() => {
            if (!resolvedSelectionKey) return;
            rowSelection.replace();
        }, [resolvedSelectionKey, rowSelection]);

        const handleRowPress = React.useCallback((event?: GestureResponderEvent) => {
            if (suppressNextPressRef.current) {
                suppressNextPressRef.current = false;
                return;
            }

            const rawEvent = event as unknown as Record<string, unknown> | undefined;
            const nativeEvent = event?.nativeEvent as Record<string, unknown> | undefined;
            const shiftKey = rawEvent?.shiftKey === true || nativeEvent?.shiftKey === true;
            const ctrlKey = rawEvent?.ctrlKey === true || nativeEvent?.ctrlKey === true;
            const metaKey = rawEvent?.metaKey === true || nativeEvent?.metaKey === true;
            const selectionAction = resolvedSelectionKey
                ? Platform.OS === 'web'
                    ? resolveSessionListSelectionPointerAction({
                        isSelectionMode: rowSelection.isSelectionMode,
                        platform: resolveKeyboardPlatform(),
                        shiftKey,
                        ctrlKey,
                        metaKey,
                    })
                    : rowSelection.isSelectionMode
                        ? 'toggle'
                        : 'open'
                : 'open';

            if (selectionAction !== 'open') {
                stopRowPressPropagation(event);
                if (contextMenuOpen) {
                    setContextMenuOpen(false);
                }
                switch (selectionAction) {
                    case 'toggle':
                        rowSelection.toggle();
                        return;
                    case 'selectRange':
                        rowSelection.selectRange();
                        return;
                }
            }

            if (contextMenuOpen) {
                setContextMenuOpen(false);
            }
            navigateToSession(resolvedSession.id, serverId ? { serverId } : undefined);
        }, [
            contextMenuOpen,
            navigateToSession,
            resolvedSelectionKey,
            resolvedSession.id,
            rowSelection,
            serverId,
            setContextMenuOpen,
            stopRowPressPropagation,
        ]);

        const {
            tagMenuItems,
            handleTagMenuSelect,
            handleTagMenuCreate,
            moreMenuItems,
            handleMoreMenuSelect,
            contextMenuItems,
            handleContextMenuSelect,
            mutatingSession,
        } = useSessionRowActionMenu({
            target: sessionActionTarget,
            onOpenFollowEditor: followEditor.openEditor,
            sessionName: sessionNameResolved,
            hideInactiveSessions: Boolean(hideInactiveSessions),
            iconColor: rowActionIconColor,
            activeTags,
            knownTags,
            tagsEnabled: tagsEnabled === true,
            onSetTags,
            onTogglePinned,
            leadingMenuItems,
            onSelectLeadingMenuItem: handleSelectLeadingMenuItem,
            folderMoveMenuItems,
            onMoveToFolder,
            onSelectFolderMoveMenuItem: handleSelectFolderMoveMenuItem,
            selectionModeAvailable: Boolean(resolvedSelectionKey),
            selectionModeActive: rowSelection.isSelectionMode,
            onEnterSelectionMode: handleEnterSelectionMode,
            isNativeMobile,
            setContextMenuOpen,
            openTagsMenuFromContext: () => {
                setTagMenuEverOpened(true);
                setTagMenuOpen(true);
            },
            reminder,
        });

        const handleSwipeAction = React.useCallback(async () => {
            swipeableRef.current?.close();
            await handleMoreMenuSelect(SESSION_ACTION_ARCHIVE_ID);
        }, [handleMoreMenuSelect]);

        const rowAccessibilityActions = React.useMemo(() => {
            const actions: Array<{ name: string; label: string }> = [];
            if (typeof onMoveUp === 'function') {
                actions.push({ name: 'moveUp', label: t('common.moveUp') });
            }
            if (typeof onMoveDown === 'function') {
                actions.push({ name: 'moveDown', label: t('common.moveDown') });
            }
            if (typeof onMoveToFolder === 'function') {
                actions.push({ name: 'moveToFolder', label: t('sessionsList.moveToFolder') });
            }
            if (typeof onMoveToWorkspaceRoot === 'function') {
                actions.push({ name: 'moveToWorkspaceRoot', label: t('sessionsList.moveToWorkspaceRoot') });
            }
            if (draft && typeof onDeleteDraft === 'function') {
                actions.push({ name: 'deleteDraft', label: t('sessionDrafts.delete.action') });
            }
            return actions;
        }, [draft, onDeleteDraft, onMoveDown, onMoveToFolder, onMoveToWorkspaceRoot, onMoveUp]);

        const handleRowAccessibilityAction = React.useCallback((event: { nativeEvent?: { actionName?: string } }) => {
            switch (event.nativeEvent?.actionName) {
                case 'moveUp':
                    onMoveUp?.();
                    break;
                case 'moveDown':
                    onMoveDown?.();
                    break;
                case 'moveToFolder':
                    onMoveToFolder?.();
                    break;
                case 'moveToWorkspaceRoot':
                    onMoveToWorkspaceRoot?.();
                    break;
                case 'deleteDraft':
                    void confirmDeleteDraft();
                    break;
                default:
                    break;
            }
        }, [confirmDeleteDraft, onMoveDown, onMoveToFolder, onMoveToWorkspaceRoot, onMoveUp]);

        const {
            swipeEnabled,
            showDragGrip,
            enableLongPressContextMenu,
            suppressNextPressOnNativeContextMenuOpen,
        } = React.useMemo(() => resolveSessionRowInteractionPolicy({
            platformOs: Platform.OS,
            touchPrimaryPointer: isTouchPrimaryPointer(),
            isActiveSession,
            canStopSession,
            canArchiveSession,
            contextMenuItemCount: contextMenuItems.length,
            contextMenuOpen,
            contextMenuWasOpen: contextMenuWasOpenRef.current,
            dragEnabled,
            organizeMode,
        }), [
            canArchiveSession,
            canStopSession,
            contextMenuItems.length,
            contextMenuOpen,
            dragEnabled,
            isActiveSession,
            organizeMode,
        ]);

        React.useEffect(() => {
            // When a context menu is opened by an external gesture (e.g. session list long-press),
            // Pressable may still fire `onPress` on touch-up. Suppress that navigation *once*,
            // but don't keep suppressing while the menu stays open (that would require extra taps).
            contextMenuWasOpenRef.current = contextMenuOpen;

            if (!suppressNextPressOnNativeContextMenuOpen) {
                return;
            }

            suppressNextPressRef.current = true;
            if (clearSuppressionTimeoutRef.current) {
                clearTimeout(clearSuppressionTimeoutRef.current);
            }
            clearSuppressionTimeoutRef.current = setTimeout(() => {
                suppressNextPressRef.current = false;
                clearSuppressionTimeoutRef.current = null;
            }, CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS);

            return () => {
                if (clearSuppressionTimeoutRef.current) {
                    clearTimeout(clearSuppressionTimeoutRef.current);
                    clearSuppressionTimeoutRef.current = null;
                }
            };
        }, [contextMenuOpen, suppressNextPressOnNativeContextMenuOpen]);

        const openContextMenuFromLongPress = React.useCallback(() => {
            clearContextMenuPressInTimer();
            if (!enableLongPressContextMenu || isBeingDraggedRef.current) return;
            suppressNextPressRef.current = true;
            setContextMenuOpen(true);
        }, [clearContextMenuPressInTimer, enableLongPressContextMenu, setContextMenuOpen]);

        const pendingCount = resolvedSession.pendingCount ?? 0;
        const pendingBlockedCount = resolvedSession.pendingBlockedCount ?? 0;
        const pendingBadge = formatPendingCountBadge(pendingCount);
        const tagChipDensity: 'default' | 'compact' | 'minimal' = isMinimal ? 'minimal' : compact ? 'compact' : 'default';
        const sourceTagChips = React.useMemo(() => {
            if (!tagsEnabled || activeTags.length === 0) return [];
            return activeTags.map((tag, index) => ({ key: `${tag}:${index}`, label: tag }));
        }, [activeTags, tagsEnabled]);
        const fallbackSecondaryLineMode: SessionListSecondaryLineMode = variant === 'no-path' ? 'status' : 'path';
        const requestedSecondaryLineMode = secondaryLineMode ?? fallbackSecondaryLineMode;
        const rowDensity = isMinimal ? 'minimal' : compact ? 'compact' : 'default';
        const derivedRowAttentionState = resolveSessionRowAttentionState(resolveSessionListAttentionState({
            operational: sessionStatus.awareness.operational.primary,
            hasUnreadMessages,
            personalAttentionReason: resolvedSession.viewer?.attention.primary ?? null,
        }));
        // Retention controls placement only. It cannot turn quiet, unread, or pending facts into
        // semantic work after the canonical awareness owner stopped reporting work.
        const rowAttentionState = derivedRowAttentionState;
        const attentionIndicatorAnimationEnabled = rowAttentionAnimationEnabled
            && sessionStatus.isPulsing === true;
        const rowContextSubtitle = externalSessionIdentity?.rowMetadataLabel || sessionSubtitle;
        const rowPresentation = resolveSessionRowPresentation({
            attentionState: rowAttentionState,
            density: rowDensity,
            requestedSecondaryLineMode,
            hasPathSubtitle: Boolean(rowContextSubtitle),
            standing: attentionStanding === true,
            backgroundActive: sessionStatus.state === 'background_active',
        });
        const statusAttentionState = rowAttentionState;
        const statusAttentionIndicator = rowPresentation.attentionIndicator;
        // Content this viewer cannot read always explains itself, even behind a ready/external
        // label: a row that reports an outcome nobody can open is a lie the person cannot check.
        const statusAvailabilityNeedsExplanation = !isSessionAwarenessContentReadableV1(sessionStatus.awareness.encryption)
            || (sessionStatus.state === 'unknown'
                || sessionStatus.state === 'stale'
                || sessionStatus.state === 'disconnected');
        const effectiveSecondaryLineMode: SessionListSecondaryLineMode = statusAvailabilityNeedsExplanation
            ? 'status'
            : rowPresentation.secondaryLine === 'path'
                ? 'path'
                : 'status';
        // The row's word and tone come from the shared work-status owner, fed by the Session facts owner
        // with the status this row already projected (INT §5.3): healthy work is quiet, needs-you and
        // trouble speak in their tone. The marker beside it stays the row presentation's own.
        const workStatus = resolveWorkStatusTone({
            kind: 'session',
            facts: sessionWorkStatusFactsFromStatus(resolvedSession, sessionStatus),
        });
        const canonicalStatusSummaryText = statusAvailabilityNeedsExplanation
            ? workStatus.word
            : rowPresentation.statusTextKey
                    ? t(rowPresentation.statusTextKey)
                    : workStatus.word;
        const externalIdentityText = externalSessionIdentity?.rowMetadataLabel ?? '';
        const statusSummaryText = [canonicalStatusSummaryText, externalIdentityText]
            .filter(Boolean)
            .join(' · ');
        const currentWorkTitle = sessionStatus.awareness?.currentWork?.title;
        const statusLineText = currentWorkTitle && sessionStatus.awareness?.availability !== 'locked'
            ? `${statusSummaryText} · ${currentWorkTitle}`
            : statusSummaryText;
        const workStatusWord = workStatusWordStyle(workStatus.tone);
        // One accessible element says everything the row shows. The decorative marker is hidden
        // from accessibility, so whenever the row draws a state without writing a sentence for it
        // — every minimal row, and unread/queued-input rows in any density — the canonical row
        // presentation owner supplies the words instead of this component inferring them.
        const rowAttentionAccessibilityLabel = statusAvailabilityNeedsExplanation
            ? statusLineText
            : rowAttentionState === 'failed'
                ? t('status.error')
                : rowPresentation.attentionIndicator === 'working'
                    || rowPresentation.attentionIndicator === 'permission'
                    || rowPresentation.attentionIndicator === 'action'
                    ? statusLineText
                    : rowPresentation.statusTextKey && rowPresentation.statusTextKey !== 'status.backgroundActive'
                        ? statusLineText
                        : rowPresentation.accessibilityStatusTextKey
                            ? t(rowPresentation.accessibilityStatusTextKey)
                            : undefined;
        const normalizedReportsDepth = Math.min(Math.max(Math.trunc(reportsDepth ?? 0), 0), 3);
        const reportsChip = hasSessionRowReportsChip(resolvedSession.reports) && resolvedSession.reports
            ? <SessionRowReportsChip sessionId={resolvedSession.id} reports={resolvedSession.reports} />
            : null;
        const reportsAccessibilityLabel = [
            normalizedReportsDepth > 0 ? t('sessionWork.list.level', { level: normalizedReportsDepth + 1 }) : null,
            (resolvedSession.reports?.total ?? 0) > 0
                ? t('sessionWork.list.subSessions', { count: resolvedSession.reports?.total ?? 0 })
                : null,
        ].filter(Boolean).join('. ');
        const rowAccessibilityLabel = [sessionNameResolved, reportsAccessibilityLabel, rowAttentionAccessibilityLabel]
            .filter((value): value is string => Boolean(value?.trim()))
            .join('. ');
        const effectiveSubtitleEllipsizeMode = subtitleEllipsizeMode ?? 'head';
        const shouldShowStatusSecondaryLine = effectiveSecondaryLineMode === 'status' && statusLineText.trim().length > 0;
        const shouldShowPathSecondaryLine = effectiveSecondaryLineMode === 'path' && Boolean(rowContextSubtitle);
        const shouldUsePathSubtitleStartEllipsis = shouldShowPathSecondaryLine && effectiveSubtitleEllipsizeMode === 'head';
        const shouldUseWebPathSubtitleStartEllipsis = shouldUsePathSubtitleStartEllipsis && isWeb;
        const shouldShowIdentitySubtitleSkeleton = !isMinimal && isSessionIdentityLoading && requestedSecondaryLineMode === 'path';
        const showStandardSecondaryLine = !isMinimal && (
            shouldShowIdentitySubtitleSkeleton
            || shouldShowStatusSecondaryLine
            || shouldShowPathSecondaryLine
        );
        const shouldEmphasizeTitle = rowPresentation.titleTone === 'emphasized';
        const trailingAttentionIndicator = isMinimal ? statusAttentionIndicator : 'none';
        const showTrailingAttentionIndicator = trailingAttentionIndicator !== 'none';
        const trailingAttentionReplacesTime = trailingAttentionIndicator === 'working';
        const showTrailingActivityTime = Boolean(activityTimeLabel) && !trailingAttentionReplacesTime;
        const hasTrailingMeta = showTrailingAttentionIndicator || showTrailingActivityTime;
        const resolvedSessionListIdentityDisplay =
            sessionListIdentityDisplay === 'agentLogo' || sessionListIdentityDisplay === 'none'
                ? sessionListIdentityDisplay
                : 'avatar';
        const shouldRenderSessionListIdentity = resolvedSessionListIdentityDisplay !== 'none';
        const shouldRenderSelectionCheckbox = Boolean(resolvedSelectionKey)
            && (rowSelection.isSelectionMode || rowSelection.isSelected);
        const shouldRenderSessionListAvatar = resolvedSessionListIdentityDisplay === 'avatar';
        const tagDisplayPlan = React.useMemo(() => (
            planSessionTagDisplay({
                density: isMinimal ? 'minimal' : compact ? 'compact' : 'default',
                tags: sourceTagChips,
                rowWidth,
                hasTrailingMeta,
                hasRowActions: showRowActions,
                hasLeadingIdentity: shouldRenderSessionListIdentity || shouldRenderSelectionCheckbox,
            })
        ), [compact, hasTrailingMeta, isMinimal, rowWidth, shouldRenderSelectionCheckbox, shouldRenderSessionListIdentity, showRowActions, sourceTagChips]);
        const tagChips = tagDisplayPlan.chips;
        const showTagChips = tagChips.length > 0;
        const showInlineTagChips = showTagChips && tagDisplayPlan.placement === 'inline';
        const showBelowTagChips = showTagChips && tagDisplayPlan.placement === 'below';
        const identityMetrics = resolveSessionListRowIdentityMetrics({
            density: isMinimal ? 'minimal' : compact ? 'compact' : 'default',
            readableNativePhoneMinimal: useReadableNativePhoneMinimalRow,
        });
        const avatarSize = identityMetrics.slotSize;
        const agentLogoSize = identityMetrics.agentLogoSize;
        const normalizedFolderDepth = Math.min(Math.max(Math.trunc(folderDepth ?? 0), 0), 3);
        const identityTitleLoadingStyle = isMinimal
            ? styles.sessionTitleLoadingMinimal
            : compact
                ? styles.sessionTitleLoadingCompact
                : styles.sessionTitleLoading;
        const sessionTitleColorRole = resolveSessionRowTitleColorRole({
            mode: normalizeSessionListActiveColorMode(sessionListActiveColorMode),
            selected: selected === true || rowSelection.isSelected,
            isConnected: sessionStatus.isConnected,
            isSessionActive: resolvedSession.active === true,
            attentionState: rowAttentionState,
            titleTone: rowPresentation.titleTone === 'quiet' ? 'quiet' : 'emphasized',
        });
        const sessionTitleColor = sessionTitleColorRole === 'primary'
            ? theme.colors.text.primary
            : theme.colors.text.secondary;
        const renderTagChipRow = (placement: 'below' | 'inline') => (
            <View
                testID={`session-item-tags-${placement}-${resolvedSession.id}`}
                style={[
                    styles.tagsRow,
                    placement === 'inline' ? styles.tagsInlineRow : null,
                    compact ? styles.tagsRowCompact : null,
                    isMinimal ? styles.tagsRowMinimal : null,
                ]}
            >
                {tagChips.map((tag) => (
                    <View
                        key={tag.key}
                        style={[
                            styles.tagChip,
                            tagChipDensity === 'compact' ? styles.tagChipCompact : null,
                            tagChipDensity === 'minimal' ? styles.tagChipMinimal : null,
                            placement === 'inline' ? styles.tagChipInline : null,
                        ]}
                    >
                        <Text
                            style={[
                                styles.tagChipText,
                                tagChipDensity === 'compact' ? styles.tagChipTextCompact : null,
                                tagChipDensity === 'minimal' ? styles.tagChipTextMinimal : null,
                            ]}
                            numberOfLines={1}
                        >
                            {tag.label}
                        </Text>
                    </View>
                ))}
            </View>
        );
        const itemContent = (
            <SessionListRowPresentation
                density={rowDensity}
                readableNativePhoneMinimal={useReadableNativePhoneMinimalRow}
                textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                first={isFirst}
                last={isLast}
                selected={Boolean(selected || rowSelection.isSelected)}
                separator={Boolean(embedded && !embeddedIsLast)}
                onLayout={sourceTagChips.length > 0 ? handleRowLayout : undefined}
                renderContainer={(content, rowStyle) => (
                    // When the list carries this row itself, that is its one drag (it reaches panes too).
                    <WorkspaceDestinationRow existingMenu dragSource={!dragEnabled} href={buildScopedSessionRouteHref({
                        sessionId: resolvedSession.id, serverId: serverId ?? null,
                    })}>
                    <Pressable
                        ref={followEditor.triggerRef}
                        testID={`session-list-item-${resolvedSession.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={rowAccessibilityLabel}
                        accessibilityState={{
                            selected: Boolean(selected || rowSelection.isSelected),
                            busy: statusAttentionState === 'working',
                        }}
                        aria-pressed={Platform.OS === 'web' ? Boolean(selected || rowSelection.isSelected) : undefined}
                        aria-busy={Platform.OS === 'web' ? statusAttentionState === 'working' : undefined}
                        accessibilityActions={rowAccessibilityActions}
                        onAccessibilityAction={rowAccessibilityActions.length > 0 ? handleRowAccessibilityAction : undefined}
                        android_ripple={Platform.OS === 'android' ? {
                            color: theme.colors.surface.ripple,
                            borderless: false,
                            foreground: true,
                        } : undefined}
                        style={rowStyle}
                        onPress={handleRowPress}
                        onFocus={Platform.OS === 'web' ? rowSelection.setFocused : undefined}
                        onPressIn={enableLongPressContextMenu ? () => {
                            clearContextMenuPressInTimer();
                            contextMenuPressInTimerRef.current = setTimeout(() => {
                                contextMenuPressInTimerRef.current = null;
                                openContextMenuFromLongPress();
                            }, CONTEXT_MENU_PRESS_IN_OPEN_DELAY_MS);
                        } : undefined}
                        onPressOut={enableLongPressContextMenu ? clearContextMenuPressInTimer : undefined}
                        onLongPress={enableLongPressContextMenu ? openContextMenuFromLongPress : undefined}
                    >
                        {normalizedReportsDepth > 0 ? (
                            <View
                                testID={`session-list-item-reports-gutter-${resolvedSession.id}`}
                                accessibilityElementsHidden
                                importantForAccessibility="no-hide-descendants"
                                style={[styles.reportsGutter, { width: normalizedReportsDepth * SESSION_REPORTS_ROW_INDENT_STEP }]}
                            >
                                <View style={styles.reportsConnector} />
                            </View>
                        ) : null}
                        {content}
                    </Pressable>
                    </WorkspaceDestinationRow>
                )}
                identity={shouldRenderSessionListIdentity || shouldRenderSelectionCheckbox ? (
                    <>
                        {shouldRenderSelectionCheckbox ? (
                            <SessionListSelectionCheckbox
                                sessionId={resolvedSession.id}
                                selectionKey={resolvedSelectionKey}
                                selected={rowSelection.isSelected}
                                onPress={rowSelection.toggle}
                                style={compact ? { width: avatarSize, height: avatarSize } : undefined}
                            />
                        ) : isSessionIdentityLoading ? (
                            <Animated.View
                                testID={`session-list-avatar-loading-${resolvedSession.id}`}
                                style={[
                                    isMinimal
                                        ? useReadableNativePhoneMinimalRow
                                            ? styles.avatarLoadingMinimalNativePhone
                                            : styles.avatarLoadingMinimal
                                        : compact
                                            ? styles.avatarLoadingCompact
                                            : styles.avatarLoading,
                                    { opacity: identitySkeletonOpacity },
                                ]}
                            />
                        ) : (
                            <SessionListIdentity
                                session={resolvedSession}
                                display={resolvedSessionListIdentityDisplay}
                                serverId={serverId ?? null}
                                color={sessionTitleColor}
                                avatarSize={avatarSize}
                                agentLogoSize={agentLogoSize}
                                connected={sessionStatus.isConnected}
                                testID={`session-list-agent-logo-${resolvedSession.id}`}
                            />
                        )}
                        {!isMinimal && shouldRenderSessionListAvatar && pendingBadge ? (
                            <View
                                style={[
                                    styles.pendingCountContainer,
                                    compact ? styles.pendingCountContainerCompact : null,
                                ]}
                            >
                                <Text style={styles.pendingCountText} numberOfLines={1}>
                                    {pendingBadge}
                                </Text>
                            </View>
                        ) : null}
                        {!isMinimal && shouldRenderSessionListAvatar && draft ? (
                            <View
                                testID={`session-list-draft-indicator:${resolvedSession.id}`}
                                accessibilityRole="text"
                                accessibilityLabel={draft.preview ? `${t('sessionDrafts.badge')}, ${draft.preview}` : t('sessionDrafts.badge')}
                                accessibilityHint={t('sessionDrafts.continueEditing')}
                                style={[styles.draftIconContainer, compact ? styles.draftIconContainerCompact : null]}
                            >
                                <Icon name="pencil-simple" size={compact ? 11 : 12} color={theme.colors.text.secondary} />
                            </View>
                        ) : null}
                    </>
                ) : null}
                title={<>
                        {isSessionIdentityLoading ? (
                            <Animated.View
                                testID={`session-list-title-loading-${resolvedSession.id}`}
                                style={[
                                    identityTitleLoadingStyle,
                                    { opacity: identitySkeletonOpacity },
                                ]}
                            />
                        ) : (
                            <SessionListRowTitle
                                density={rowDensity}
                                readableNativePhoneMinimal={useReadableNativePhoneMinimalRow}
                                textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                                emphasized={Boolean(shouldEmphasizeTitle || selected || rowSelection.isSelected)}
                                color={sessionTitleColor}
                            >
                                {sessionNameResolved}
                            </SessionListRowTitle>
                        )}
                        {showServerBadge && serverName ? (
                            <View style={styles.serverBadgeContainer}>
                                <Text style={styles.serverBadgeText} numberOfLines={1}>
                                    {serverName}
                                </Text>
                            </View>
                        ) : null}
                        {reminder ? (
                            <View
                                testID={`session-list-reminder-indicator:${resolvedSession.id}`}
                                accessibilityRole="text"
                                accessibilityLabel={`${t(reminder.state === 'due' ? 'sessionsList.reminders.due' : 'sessionsList.reminders.title')}, ${formatSessionAttentionReminderDateTime(reminder.remindAt, Date.now())}`}
                                style={[styles.reminderIndicator, compact ? styles.reminderIndicatorCompact : null]}
                            >
                                <Icon
                                    name="clock"
                                    size={compact ? 11 : 12}
                                    color={reminder.state === 'due' ? theme.colors.accent.orange : theme.colors.text.secondary}
                                />
                            </View>
                        ) : null}
                </>}
                children={<>
                    {draft && !compact && draft.preview ? (
                        <SessionListRowSubtitle
                            testID={`session-list-draft-preview:${resolvedSession.id}`}
                            density={rowDensity}
                            textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                        >
                            {`${t('sessionDrafts.badge')} · ${draft.preview}`}
                        </SessionListRowSubtitle>
                    ) : showStandardSecondaryLine ? (
                        shouldShowIdentitySubtitleSkeleton ? (
                            <Animated.View
                                testID={`session-list-subtitle-loading-${resolvedSession.id}`}
                                style={[
                                    compact ? styles.sessionSubtitleLoadingCompact : styles.sessionSubtitleLoading,
                                    { opacity: identitySkeletonOpacity },
                                ]}
                            />
                        ) : effectiveSecondaryLineMode === 'status' ? (
                            <View
                                testID={`session-list-status-subtitle-${resolvedSession.id}-${rowAttentionState}`}
                                style={styles.secondaryLineRow}
                            >
                                <View style={styles.secondaryStatusDotContainer}>
                                    {statusAttentionIndicator !== 'none' ? (
                                        <SessionRowAttentionIndicator
                                            indicator={statusAttentionIndicator}
                                            sessionId={`${resolvedSession.id}-secondary`}
                                            attentionState={statusAttentionState}
                                            workingMode={workingIndicatorMode}
                                            animationEnabled={attentionIndicatorAnimationEnabled}
                                        />
                                    ) : null}
                                </View>
                                <Text
                                    testID={`session-list-status-subtitle-text-${resolvedSession.id}-${rowAttentionState}`}
                                    style={[
                                        styles.statusText,
                                        compact ? styles.statusTextCompact : null,
                                        workStatusWord ?? styles.statusTextQuiet,
                                    ]}
                                    numberOfLines={1}
                                >
                                    {statusLineText}
                                </Text>
                            </View>
                        ) : (
                            <SessionListRowSubtitle
                                density={rowDensity}
                                textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                                style={shouldUseWebPathSubtitleStartEllipsis ? styles.sessionPathSubtitleWeb : null}
                                ellipsizeMode={shouldUseWebPathSubtitleStartEllipsis ? undefined : effectiveSubtitleEllipsizeMode}
                            >
                                {shouldUseWebPathSubtitleStartEllipsis ? (
                                    <Text style={styles.sessionPathSubtitleTextWeb}>
                                        {rowContextSubtitle}
                                    </Text>
                                ) : rowContextSubtitle}
                            </SessionListRowSubtitle>
                        )
                    ) : null}

                    {showBelowTagChips ? renderTagChipRow('below') : null}
                </>}
                trailingProps={{
                    testID: 'session-item-right-area',
                    onPointerEnter: isWeb ? handleActionsHoverIn : undefined,
                    onPointerLeave: isWeb ? handleActionsHoverOut : undefined,
                }}
                trailing={<>
                    {showInlineTagChips ? renderTagChipRow('inline') : null}
                    <CopiedPill
                        visible={copyFeedback.isCopied(resolvedSession.id)}
                        testID={`session-item-copy-debug-feedback:${resolvedSession.id}`}
                    />
                    {showRowActions ? (
                        <View style={styles.rowActionsRow}>
                            {showTagAction ? (
                                tagMenuEverOpened || Platform.OS === 'web' ? (
                                    <DropdownMenu
                                        open={tagMenuOpen}
                                        onOpenChange={(next) => {
                                            setTagMenuOpen(next);
                                            if (next) setTagMenuEverOpened(true);
                                        }}
                                        items={tagMenuItems}
                                        onSelect={handleTagMenuSelect}
                                        onCreateItem={handleTagMenuCreate}
                                        createItemDisplay={(query) => ({
                                            title: `${t('dropdown.createItem.prefix')} ${query}`,
                                            leftGap: 8,
                                            rowContainerStyle: { paddingVertical: 6 },
                                            titleStyle: { fontSize: 14, lineHeight: 20 },
                                            titleNode: (
                                                <>
                                                    {t('dropdown.createItem.prefix')}
                                                    <RNText style={styles.tagChipInlineText} numberOfLines={1}>
                                                        {query}
                                                    </RNText>
                                                </>
                                            ),
                                            icon: <Icon name="plus" size={16} color={rowActionIconColor} />,
                                        })}
                                        placement="bottom"
                                        popoverAnchorAlign="end"
                                        variant="slim"
                                        search={true}
                                        searchPlaceholder={t('sessionTags.searchOrAddPlaceholder')}
                                        emptyLabel={null}
                                        showCategoryTitles={false}
                                        matchTriggerWidth={false}
                                        maxWidthCap={220}
                                        popoverPortalWebTarget="body"
                                        trigger={({ toggle }) => (
                                            <Pressable
                                                testID="session-item-tag-action"
                                                style={styles.rowActionButton}
                                                onPress={(e) => {
                                                    stopRowPressPropagation(e);
                                                    setTagMenuEverOpened(true);
                                                    toggle();
                                                }}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('sessionTags.editTagsLabel')}
                                                hitSlop={8}
                                            >
                                                <TagIcon size={14} color={rowActionIconColor} />
                                            </Pressable>
                                        )}
                                    />
                                ) : (
                                    <Pressable
                                        testID="session-item-tag-action"
                                        style={styles.rowActionButton}
                                        onPress={(e) => {
                                            stopRowPressPropagation(e);
                                            setTagMenuEverOpened(true);
                                            setTagMenuOpen(true);
                                        }}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('sessionTags.editTagsLabel')}
                                        hitSlop={8}
                                    >
                                        <TagIcon size={14} color={rowActionIconColor} />
                                    </Pressable>
                                )
                            ) : null}
                            {supportsPin ? (
                                <Pressable
                                    style={styles.rowActionButton}
                                    onPress={(e) => {
                                        stopRowPressPropagation(e);
                                        handleTogglePinnedAction();
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={pinned ? t('sessionInfo.unpinSession') : t('sessionInfo.pinSession')}
                                    hitSlop={8}
                                >
                                    {pinned ? (
                                        <PinSlashIcon size={14} color={rowActionIconColor} />
                                    ) : (
                                        <PinIcon size={14} color={rowActionIconColor} />
                                    )}
                                </Pressable>
                            ) : null}
                            {moreMenuItems.length > 0 ? (
                                <DropdownMenu
                                    open={moreMenuOpen}
                                    onOpenChange={setMoreMenuOpen}
                                    items={moreMenuItems}
                                    onSelect={handleMoreMenuSelect}
                                    placement="bottom"
                                    popoverAnchorAlign="end"
                                    variant="slim"
                                    matchTriggerWidth={false}
                                    maxWidthCap={220}
                                    showCategoryTitles={false}
                                    popoverPortalWebTarget="body"
                                    trigger={({ toggle }) => (
                                        <Pressable
                                            testID="session-item-more-menu"
                                            style={styles.rowActionButton}
                                            onPress={(e) => {
                                                stopRowPressPropagation(e);
                                                toggle();
                                            }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('common.moreActions')}
                                            hitSlop={8}
                                        >
                                            <Icon name="dots-three" size={14} color={rowActionIconColor} />
                                        </Pressable>
                                    )}
                                />
                            ) : null}
                        </View>
                    ) : reportsChip || showTrailingAttentionIndicator || showTrailingActivityTime ? (
                        <View style={styles.trailingMetaRow}>
                            {reportsChip}
                            {showTrailingAttentionIndicator ? (
                                <SessionRowAttentionIndicator
                                    indicator={trailingAttentionIndicator}
                                    sessionId={`${resolvedSession.id}-trailing`}
                                    attentionState={statusAttentionState}
                                    workingMode={workingIndicatorMode}
                                    animationEnabled={attentionIndicatorAnimationEnabled}
                                />
                            ) : null}
                            {showTrailingActivityTime ? (
                                <Text
                                    style={[styles.activityTime, isMinimal ? styles.activityTimeMinimal : null]}
                                    numberOfLines={1}
                                >
                                    {activityTimeLabel}
                                </Text>
                            ) : null}
                        </View>
                    ) : null}
                    {showDragGrip && dragGripGesture ? (
                        <GestureDetector gesture={dragGripGesture}>
                            <EntityDragGrip
                                density="touch"
                                active={isBeingDragged === true}
                                accessibilityLabel={t('entityDragDrop.organize.grip', { item: sessionNameResolved })}
                                testID={`session-item-drag-grip-${resolvedSession.id}`}
                            />
                        </GestureDetector>
                    ) : null}
                </>}
            />
        );

        const containerStyles = [
            embedded ? styles.sessionItemContainerEmbedded : styles.sessionItemContainer,
            !embedded && normalizedFolderDepth > 0
                ? { marginLeft: SESSION_FOLDER_ROW_CHROME_INDENT_BASE + normalizedFolderDepth * SESSION_FOLDER_ROW_CHROME_INDENT_STEP }
                : null,
            embedded
                ? null
                : isSingle
                    ? styles.sessionItemContainerSingle
                    : isFirst
                        ? styles.sessionItemContainerFirst
                        : isLast
                            ? styles.sessionItemContainerLast
                            : null,
        ];

        const menuNodes = isNativeMobile ? (
            <>
                {contextMenuItems.length > 0 ? (
                    <ContextMenu
                        open={contextMenuOpen}
                        onOpenChange={setContextMenuOpen}
                        anchorRef={contextMenuAnchorRef}
                        items={contextMenuItems}
                        onSelect={handleContextMenuSelect}
                        placement="auto"
                        variant="slim"
                        showCategoryTitles={false}
                        maxWidthCap={260}
                    />
                ) : null}
                {supportsTag ? (
                    <ContextMenu
                        open={tagMenuOpen}
                        onOpenChange={(next) => {
                            setTagMenuOpen(next);
                            if (next) setTagMenuEverOpened(true);
                        }}
                        anchorRef={contextMenuAnchorRef}
                        items={tagMenuItems}
                        onSelect={handleTagMenuSelect}
                        onCreateItem={handleTagMenuCreate}
                        createItemDisplay={(query) => ({
                            title: `${t('dropdown.createItem.prefix')} ${query}`,
                            leftGap: 8,
                            rowContainerStyle: { paddingVertical: 6 },
                            titleStyle: { fontSize: 14, lineHeight: 20 },
                            titleNode: (
                                <>
                                    {t('dropdown.createItem.prefix')}
                                    <RNText style={styles.tagChipInlineText} numberOfLines={1}>
                                        {query}
                                    </RNText>
                                </>
                            ),
                            icon: <Icon name="plus" size={16} color={rowActionIconColor} />,
                        })}
                        placement="auto"
                        variant="slim"
                        search={true}
                        searchPlaceholder={t('sessionTags.searchOrAddPlaceholder')}
                        emptyLabel={null}
                        showCategoryTitles={false}
                        matchTriggerWidth={false}
                        maxWidthCap={260}
                    />
                ) : null}
            </>
        ) : null;

        if (!swipeEnabled) {
            return (
                <View
                    ref={contextMenuAnchorRef}
                    collapsable={false}
                    style={containerStyles}
                    onPointerEnter={isWeb ? handleRowPointerEnter : undefined}
                    onPointerLeave={isWeb ? handleRowPointerLeave : undefined}
                >
                    {itemContent}
                    {menuNodes}
                    {followEditor.editor}
                </View>
            );
        }

        const renderRightActions = () => (
            <Pressable style={styles.swipeAction} onPress={handleSwipeAction} disabled={mutatingSession}>
                <Icon name="archive" size={20} color={theme.colors.button.primary.tint} />
                <Text style={styles.swipeActionText} numberOfLines={2}>
                    {t('sessionInfo.archiveSession')}
                </Text>
            </Pressable>
        );

        return (
            <View
                ref={contextMenuAnchorRef}
                collapsable={false}
                style={containerStyles}
                onPointerEnter={isWeb ? handleRowPointerEnter : undefined}
                onPointerLeave={isWeb ? handleRowPointerLeave : undefined}
            >
                <Swipeable
                    ref={swipeableRef}
                    renderRightActions={renderRightActions}
                    overshootRight={false}
                    enabled={!mutatingSession}
                >
                    {itemContent}
                </Swipeable>
                {menuNodes}
                {followEditor.editor}
            </View>
        );
    },
);

function SessionItemFromRowViewModel(props: SessionItemProps) {
    const { theme } = useUnistyles();
    const { rowViewModel, ...itemProps } = props;
    const rowSession = rowViewModel.session;
    const rowStatus = rowViewModel.sessionStatus;
    if (!rowSession || !rowStatus) {
        return null;
    }
    const session = resolveSessionItemEffectiveSession({
        rowSession,
        providedSession: itemProps.session,
    });
    const sessionStatus = session === rowSession ? rowStatus : getSessionStatus(session, Date.now(), {
        workingTextMode: 'static',
        statusColors: theme.colors.status,
    });
    const contentUnavailable = !isSessionAwarenessContentReadableV1(sessionStatus.awareness.encryption);
    // Encryption pending is not a reason to forget a name this device already holds:
    // the owner keeps a safe cached title and falls back only when none exists, so the
    // list row and the detail header call the same Session the same thing. Handing it
    // an empty string discarded that title and made every locked row anonymous.
    const sessionNameResolved = contentUnavailable
        ? resolveLockedSessionTitle(getSessionName(session, itemProps.serverId))
        : getSessionName(session, itemProps.serverId);

    return (
        <SessionItemContent
            {...itemProps}
            session={session}
            subtitleEllipsizeMode={itemProps.subtitleEllipsizeMode ?? rowViewModel.subtitleEllipsizeMode}
            serverId={itemProps.serverId}
            serverName={itemProps.serverName}
            showServerBadge={rowViewModel.showServerBadge}
            pinned={rowViewModel.pinned}
            tags={rowViewModel.tags}
            tagsEnabled={itemProps.tagsEnabled}
            selected={rowViewModel.selected}
            isFirst={rowViewModel.isFirst}
            isLast={rowViewModel.isLast}
            isSingle={rowViewModel.isSingle}
            secondaryLineMode={itemProps.secondaryLineMode ?? rowViewModel.secondaryLineMode}
            activityTimeLabel={rowViewModel.activityTimeLabel}
            sessionStatus={sessionStatus}
            externalSessionIdentity={rowViewModel.externalSessionIdentity}
            sessionNameResolved={sessionNameResolved}
            sessionSubtitle={contentUnavailable ? '' : itemProps.subtitleOverride ?? rowViewModel.subtitleOverride ?? getSessionSubtitle(session, itemProps.serverId)}
            isSessionIdentityLoading={rowViewModel.isIdentityLoading}
            hasUnreadMessages={rowViewModel.hasUnreadMessages}
            workingIndicatorMode={rowViewModel.workingIndicatorMode}
            attentionStanding={rowViewModel.attentionStanding}
            isAttentionStanding={rowViewModel.isAttentionStanding}
            attentionStandingEnabled={rowViewModel.attentionStandingEnabled}
            rowAttentionAnimationEnabled={itemProps.rowAttentionAnimationEnabled !== false}
            sessionListIdentityDisplay={normalizeSessionListIdentityDisplay(rowViewModel.identityDisplay)}
            sessionListActiveColorMode={normalizeSessionItemActiveColorMode(rowViewModel.activeColorMode)}
            hideInactiveSessions={itemProps.hideInactiveSessions ?? rowViewModel.hideInactiveSessions}
            draft={rowViewModel.draft}
            reminder={rowViewModel.reminder}
        />
    );
}

export const SessionItem = React.memo(function SessionItem(props: SessionItemProps | WorkflowRunItemProps) {
    if ('kind' in props && props.kind === 'workflow_run') return <WorkflowRunItemBody {...props} />;
    if (!('rowViewModel' in props)) return null;
    if (!props.rowViewModel) return null;
    return <SessionItemFromRowViewModel {...props} />;
});
