import { useSessionArchivePending } from '@/hooks/session/useSessionArchivePending';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { HAPPIER_META_COLUMN_STYLE, HappierMaterialRoleProvider, useContainingHappierMaterialRole, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { readSessionLiveManagedSessionCountV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import React from 'react';
import { useSessionListAttentionActivity } from './useSessionListAttentionInteraction';
import {
    Platform,
    Pressable,
    View,
    type GestureResponderEvent,
    type StyleProp,
    type ViewStyle,
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
import { isWorkStatusNeedsYou, resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { CollectionRowNeedsYouLeading } from '@/components/ui/lists/collection/CollectionRowNeedsYouHighlight';
import { sessionWorkStatusFactsFromStatus } from '@/components/work/status/sessionWorkStatusFacts';
import { createCollectionSessionRequestRef } from '@/components/ui/lists/collection/collectionRequestRef';
import { CollectionRequestPeek } from '@/components/ui/lists/collection/CollectionRequestPeek';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { deriveSessionCoordinatorV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorV1';
import { formatPendingCountBadge } from '@/components/sessions/pendingBadge';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useWorkspaceOpenActions } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { useEntityComposerMention } from '@/components/ui/treeDragDrop/useEntityComposerMention';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { t } from '@/text';
import { hasSessionListUnreadAttention } from '@/sync/domains/session/listing/sessionListBackgroundWorkAttention';
import {
    type SessionListSecondaryLineMode,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionSubtitle, getSessionStatus, type SessionStatus } from '@/utils/sessions/sessionUtils';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { PinIcon, PinSlashIcon } from './sessionPinIcons';
import { TagIcon } from './sessionTagIcons';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import {
    resolveSessionRowPresentation,
} from './row/resolveSessionRowPresentation';
import {
    normalizeSessionListActiveColorMode,
    resolveSessionRowTitleColorRole,
    sessionRowTitleInk,
} from './row/sessionRowTitleColorRole';
import { WorkStatusRowMark, WorkStatusRowWord } from '@/components/work/status/WorkStatusRowMark';
import { resolveWorkStatusRowMark } from '@/components/work/status/workStatusRowMark';
import { SessionRowReportsChip, SessionRowReportsDisclosure, hasSessionRowReportsChip } from './row/SessionRowReportsChip';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { CollectionRowBadge, CollectionRowContent, CollectionRowLine, CollectionRowTitle, useTouchCompactRow } from '@/components/ui/lists/collection/CollectionRowContent';
import { WorkflowRunItemBody, type WorkflowRunItemProps } from './row/WorkflowRunItemBody';
import { useWorkflowSessionOccurrence } from './row/useWorkflowSessionOccurrence';
import {
    SESSION_LIST_ROW_SELECTION_RADIUS,
    resolveCollectionRowDensity,
    resolveSessionListRowIdentityMetrics,
    SESSION_LIST_ROW_IDENTITY_METRICS,
    resolveSessionListRowStatusTextMetrics,
} from './resolveSessionListDensityViewState';
import { resolveSessionRowInteractionPolicy } from './row/resolveSessionRowInteractionPolicy';
import { SESSION_LIST_SHEET_INSET_PX } from './sessionListStyles';
import { resolveSessionItemTagCollections } from './sessionTagUtils';
import { planSessionTagDisplay } from './sessionTagPlacement';
import { EntityDragGrip } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { GlassSurface, useContainingGlassSurfaceGroup } from '@/components/ui/glass/GlassSurface';
import { useGlassMaterialColorResolver } from '@/components/ui/glass/useGlassSurfaceColor';
import { useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import type { SessionListRowViewModel } from './sessionListRowViewModels';
import type { SessionListGuardState } from '@/sync/domains/session/listing/sessionListRenderable';
import { GuardCountdown } from '@/components/machines/guard/GuardCountdown';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_TALK_ID,
    SESSION_ACTION_UNPIN_ID,
} from '@/components/sessions/actions/sessionActionIds';
import { listVisibleSessionActionIds } from '@/components/sessions/actions/sessionActionAvailability';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { SessionListSelectionCheckbox } from './selection/SessionListSelectionCheckbox';
import { useOptionalSessionListSelectionRow } from './selection/SessionListSelectionContext';
import { resolveSessionListSelectionPointerAction } from './selection/sessionListSelectionPointer';
import { useSessionRowActionMenu } from './row/actionMenu/useSessionRowActionMenu';
import type { SessionRowSectionMove, SessionRowSpaceMembership } from './useSessionListRowMoveActionHandlers';
import { formatSessionAttentionReminderDateTime } from './row/actionMenu/sessionAttentionReminderAction';
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
    useActiveServerAccountScope,
    useLocalSetting,
    useSetting,
} from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import type { ExternalSessionIdentityPresentation } from '../presentation/externalSessionIdentityPresentation';
import {
    normalizeSessionListIdentityDisplay,
    SessionListIdentity,
    type SessionListIdentityDisplay,
} from './SessionListIdentity';
import type { BotActivity } from '@/components/sessions/bots/botActivity';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useWorkspaceFavicon } from './useWorkspaceFavicon';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { resolveMachineTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { selectSessionViewShellSessionForRouteState } from './sessionViewStableSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useSessionListRowDraftPreview, type SessionListRowDraftPreviewSource } from './useSessionListRowExistingDraft';
import type { SessionForkReplaySettingsSource } from '@/sync/domains/sessionFork/resolveSessionForkReplayOptions';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

const SESSION_ROW_ORGANIZE_LIST_MENU_ITEM_ID = 'session.organizeList';

const CONTEXT_MENU_PRESS_IN_OPEN_DELAY_MS = 350;
const CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS = 600;
const SESSION_REPORTS_ROW_INDENT_STEP = 22;
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

type SessionItemActiveColorMode = 'activityAndAttention' | 'attentionOnly' | 'allActive';

export type SessionItemBaseProps = Readonly<{
    embedded?: boolean;
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
    /** Canonical rendered occurrence; selectionKey remains the Session entity. */
    occurrenceId?: string;
    /** The row is the Needs you shelf's mirror: its heading already says so, so the opt-in highlight stays off. */
    inAttentionShelf?: boolean;
    selected?: boolean;
    variant?: 'default' | 'no-path';
    secondaryLineMode?: SessionListSecondaryLineMode;
    compact?: boolean;
    compactMinimal?: boolean;
    /** Level under a lead in the `manager` tree (ORC §3.8); 0 or absent draws the row at its own level. */
    reportsDepth?: number;
    /** A lead whose reports are nested under it in this list: their fold state (lab `b-launch N`). */
    reportsDisclosure?: 'collapsed' | 'expanded';
    /** Writes the explicit local fold choice for the lead's list node. */
    onSetReportsCollapsed?: (nodeId: string, collapsed: boolean) => void;
    onMoveToFolder?: () => void;
    /** Move to section as the row menu's submenu (lab `clsections:menu`). */
    sectionMove?: SessionRowSectionMove;
    spaceMembership?: SessionRowSpaceMembership;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onDeleteDraft?: () => void | Promise<void>;
    /** Where the row's draft preview text is read; absent for rows drawn without a listed draft. */
    draftPreview?: SessionListRowDraftPreviewSource;
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
    /**
     * The Bots roster's rows: Talk sits beside More on hover/focus (the shared `ui.session.talk`
     * action), in place of the list's tag and pin affordances.
     */
    showTalkAction?: boolean;
    /**
     * The Bots roster's rows: an offline Bot's age is already its time meta, so the row adds no
     * "Last seen" line of its own (lab `b-rail A`). A Bot's outcome (an error, ready for review) still speaks; an offline row never claims to be working.
     */
    quietWhenOffline?: boolean;
    /** The Bots roster's compact More menu (lab `b-rail M`) instead of the list's. */
    actionMenuSurface?: 'rowMenu' | 'botsRoster';
    /** A Bot row's `botActivity` from the roster's own reading; its face shows it in the mouth. */
    botActivity?: BotActivity;
    /** Runs after the row opened its Session (a popover that hosts the row closes). */
    onOpened?: () => void;
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
    /** The guard's word replaces the activity time: "Stops in 4:52" (amber, a decision is open) or a quiet "Stopped". */
    guardState?: SessionListGuardState | null;
    hasUnreadMessages: boolean;
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
    /** P5 row context (lab `clctx`); absent for rows drawn outside the Sessions list. */
    rowContext?: SessionListRowViewModel['rowContext'];
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

const stylesheet = StyleSheet.create((theme) => ({
    // Rows lie flat on the column's plane (lab `clflat`): a group is its label and its rows, apart from
    // the next group by space alone. The row draws no sheet, border or shadow; its fill is its own.
    sessionItemContainer: {
        // The column's gutter (the shared column frame), where every navigation row's fill starts.
        marginHorizontal: SESSION_LIST_SHEET_INSET_PX,
        borderRadius: SESSION_LIST_ROW_SELECTION_RADIUS,
        overflow: 'hidden',
    },
    sessionItemContainerEmbedded: {
        marginHorizontal: 0,
        marginBottom: 0,
        overflow: 'hidden',
    },
    avatarLoading: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.skeleton,
    },
    avatarLoadingCompact: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.skeleton,
    },
    avatarLoadingMinimal: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.skeleton,
    },
    avatarLoadingMinimalNativePhone: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.skeleton,
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
        backgroundColor: theme.colors.surface.skeleton,
        marginTop: 3,
    },
    sessionSubtitleLoadingCompact: {
        width: '42%',
        height: 9,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.skeleton,
        marginTop: theme.space.s2,
    },
    serverBadgeContainer: {
        borderRadius: 999,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        // Ink, not a plane colour: the chip reads on the navigation canvas and on a selected row alike.
        backgroundColor: theme.colors.surface.selected,
        maxWidth: 140,
    },
    serverBadgeText: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    // The `manager` tree: a report sits one step in, joined to its lead by a hairline elbow.
    reportsGutter: {
        alignSelf: 'stretch',
        alignItems: 'flex-end',
    },
    reportsConnector: {
        width: 10,
        height: '50%',
        marginRight: theme.space.s6,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomLeftRadius: 6,
        borderColor: theme.colors.border.default,
    },
    trailingMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: theme.space.s2,
    },
    rowActionsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
    },
    rowActionIcon: {
        color: theme.colors.text.secondary,
    },
    tagsRow: {
        flexDirection: 'row',
        flexWrap: 'nowrap',
        overflow: 'hidden',
        gap: theme.space.s4,
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
        marginRight: theme.space.s4,
        maxWidth: 82,
    },
    tagChip: {
        borderRadius: 999,
        paddingHorizontal: theme.space.s6,
        paddingVertical: theme.space.s2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        // Ink, not a plane colour: the chip reads on the navigation canvas and on a selected row alike.
        backgroundColor: theme.colors.surface.selected,
        maxWidth: 120,
    },
    tagChipCompact: {
        paddingHorizontal: theme.space.s6,
        paddingVertical: 1,
        maxWidth: 110,
    },
    tagChipMinimal: {
        paddingHorizontal: theme.space.s6,
        paddingVertical: 1,
        maxWidth: 96,
    },
    tagChipInline: {
        maxWidth: 74,
    },
    tagChipText: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    tagChipInlineText: {
        borderRadius: 999,
        paddingHorizontal: theme.space.s6,
        paddingVertical: theme.space.s2,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        // Ink, not a plane colour: the chip reads on the navigation canvas and on a selected row alike.
        backgroundColor: theme.colors.surface.selected,
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
        marginLeft: theme.space.s8,
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
        gap: theme.space.s4,
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
        ...resolveSessionListRowStatusTextMetrics('default'),
        ...Typography.default(),
    },
    statusTextCompact: {
        ...resolveSessionListRowStatusTextMetrics('compact'),
    },
    statusTextQuiet: {
        color: theme.colors.text.secondary,
    },
    statusTextMinimal: {
        ...resolveSessionListRowStatusTextMetrics('minimal'),
    },
    // The row's meta: the shared right-aligned tabular column, so times scan down the list.
    activityTime: {
        ...Typography.variant('micro'),
        color: theme.colors.text.secondary,
        ...HAPPIER_META_COLUMN_STYLE,
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    trailingStatusGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        // The word stands clear of the title it follows.
        marginLeft: theme.space.s6,
    },
    trailingStatusWord: {
        flexShrink: 0,
    },
    swipeActionText: {
        marginTop: theme.space.s4,
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.button.primary.tint,
        textAlign: 'center',
    },
}));

const SessionItemContent = React.memo(
    ({
        embedded,
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
        occurrenceId,
        inAttentionShelf,
        selected,
        variant,
        secondaryLineMode,
        compact,
        compactMinimal,
        reportsDepth,
        reportsDisclosure,
        onSetReportsCollapsed,
        onMoveToFolder,
        sectionMove,
        spaceMembership,
        onMoveToWorkspaceRoot,
        onMoveUp,
        onMoveDown,
        onDeleteDraft,
        draftPreview,
        dragGripGesture,
        isBeingDragged,
        dragEnabled = false,
        organizeMode = false,
        nativeContextMenuOpen,
        onNativeContextMenuOpenChange,
        agentSwitchingEnabled = false,
        showTalkAction = false,
        quietWhenOffline = false,
        actionMenuSurface = 'rowMenu',
        botActivity,
        onOpened,
        forkActionContext,
        sessionStatus,
        externalSessionIdentity,
        sessionNameResolved: savedSessionName,
        sessionSubtitle,
        isSessionIdentityLoading,
        activityTimeLabel,
        guardState,
        hasUnreadMessages,
        attentionStanding,
        isAttentionStanding,
        attentionStandingEnabled,
        rowAttentionAnimationEnabled,
        sessionListIdentityDisplay,
        sessionListActiveColorMode,
        hideInactiveSessions,
        draft,
        reminder,
        rowContext,
    }: SessionItemContentProps) => {
        const router = useDestinationRouter();
        const { theme } = useUnistyles();
        // A Project-led mark observes the Project's one shared favicon result (P5 U5): the visible Project
        // header owns the demand, so a row never resolves, retries or holds the request (`demand: false`).
        const rowFaviconSource = rowContext && (rowContext.leadingMark === 'project' || rowContext.leadingMark === 'projectWithAgent')
            ? rowContext.projectFaviconSource : null;
        const rowProjectFavicon = useWorkspaceFavicon({
            enabled: rowFaviconSource !== null,
            serverId: rowFaviconSource?.serverId ?? null,
            machineId: rowFaviconSource?.machineId ?? null,
            workspacePath: rowFaviconSource?.workspacePath ?? null,
            demand: false,
        });
        const workflowOccurrence = useWorkflowSessionOccurrence({
            sessionId: session.id, origin: session.origin, serverId,
            enabled: (reportsDepth ?? 0) > 0 && rowAttentionAnimationEnabled !== false
                && isSessionAwarenessContentReadableV1(sessionStatus.awareness.encryption),
        });
        const sessionNameResolved = workflowOccurrence?.title ?? savedSessionName;
        const mention = useEntityComposerMention();
        const mentionScope = useActiveServerAccountScope();
        const materialColor = useHappierMaterialColorResolver();
        const containingGroup = useContainingGlassSurfaceGroup();
        const mutedPaint = { backgroundColor: materialColor(theme.colors.surface.elevated) };
        const insetPaint = { backgroundColor: materialColor(theme.colors.surface.inset) };
        // Keep Unistyles' original layout objects; only the containing material changes paint.
        const styles = {
            ...stylesheet,
            sessionItemContainer: stylesheet.sessionItemContainer,
            avatarLoading: [stylesheet.avatarLoading, mutedPaint],
            avatarLoadingCompact: [stylesheet.avatarLoadingCompact, mutedPaint],
            avatarLoadingMinimal: [stylesheet.avatarLoadingMinimal, mutedPaint],
            avatarLoadingMinimalNativePhone: [stylesheet.avatarLoadingMinimalNativePhone, mutedPaint],
            sessionTitleLoading: [stylesheet.sessionTitleLoading, mutedPaint],
            sessionTitleLoadingCompact: [stylesheet.sessionTitleLoadingCompact, mutedPaint],
            sessionTitleLoadingMinimal: [stylesheet.sessionTitleLoadingMinimal, mutedPaint],
            sessionSubtitleLoading: [stylesheet.sessionSubtitleLoading, insetPaint],
            sessionSubtitleLoadingCompact: [stylesheet.sessionSubtitleLoadingCompact, insetPaint],
            // The count sits over the avatar's image, so it keeps a solid fill inside glass to stay legible.
            pendingCountContainer: [stylesheet.pendingCountContainer, {
                backgroundColor: materialColor(theme.colors.input.background, undefined, 'solidControl'),
                borderColor: materialColor(theme.colors.background?.canvas ?? 'transparent', theme.colors.border.default),
            }],
        };
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
            () => readSessionRowPresentationAgentId(resolvedSession),
            [resolvedSession],
        );
        const resolvedSelectionKey = selectionKey ?? '';
        const occurrenceTestId = occurrenceId ?? resolvedSession.id;
        const resolvedSelectionOccurrenceKey = occurrenceId ?? resolvedSelectionKey;
        const rowSelection = useOptionalSessionListSelectionRow(resolvedSelectionOccurrenceKey);
        // Metadata can remain unopened until this row is demanded. Its reserved
        // identity slots must stay quiet rather than running a presentation clock.
        const navigateToSession = useNavigateToSession();
        // Open in a kept tab or beside the focused pane, through the workspace owner (workspace lab O).
        const workspaceOpen = useWorkspaceOpenActions(buildScopedSessionRouteHref({
            sessionId: resolvedSession.id,
            serverId: serverId ?? null,
        }));
        const swipeableRef = React.useRef<Swipeable | null>(null);
        const contextMenuAnchorRef = React.useRef<View>(null);
        // The row's picture: an accepted Pin to rail travels from here (lab `b-rail` signature move).
        const identityRef = React.useRef<View>(null);
        const followEditor = useAccountSessionFollowEditorHost({
            serverId: serverId ?? null,
            sessionId: resolvedSession.id,
            anchorRef: contextMenuAnchorRef,
        });
        const isRailPinned = storage(state => serverId
            ? state.sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey(serverId, resolvedSession.id)]?.railPinned === true
            : false);
        const sessionActionTarget = React.useMemo(() => createSessionActionTarget({
            session: resolvedSession,
            serverId: serverId ?? null,
            isConnected: sessionStatus.isConnected,
            currentUserId: currentUserId ?? null,
            isPinned: Boolean(pinned),
            isRailPinned,
            attentionStandingEnabled: attentionStandingEnabled === true,
            followEnabled: followEditor.enabled,
            attentionStanding: isAttentionStanding === true,
        }), [
            attentionStandingEnabled,
            followEditor.enabled,
            currentUserId,
            isAttentionStanding,
            isRailPinned,
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
        const copyFeedback = useHappierCopyFeedback();
        const [rowWidth, setRowWidth] = React.useState<number | null>(null);
        const isWeb = Platform.OS === 'web';
        const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
        const touchCompactRow = useTouchCompactRow(isMinimal);
        // A carried row is a quiet ghost of its place (lab E1 `.dd-src`): its actions can't be used mid-carry.
        // A touch screen has no hover to reveal a Bot roster row's Talk and More, so they stay beside it (lab b-rail Ap).
        const touchRosterActions = showTalkAction && touchPrimaryPointer;
        const showRowActions = isBeingDragged !== true
            && (touchRosterActions || (isWeb && (isRowHovered || isActionsHovered || tagMenuOpen || moreMenuOpen)));
        const rowActionIconColor = theme.colors.text.secondary;
        // Each action is the shared icon button at its drawn 24 px. Its hit area reaches half the real gap
        // to the neighbour beside it and stays inside the action band, never into the rows above and below.
        const rowActionButtonProps = {
            size: 24,
            variant: 'plain',
            interactiveTargetEdgesPx: { leading: theme.space.s2 / 2, trailing: theme.space.s2 / 2, top: 0, bottom: 0 },
        } as const;
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
        const talkActionVisible = showTalkAction && listVisibleSessionActionIds({ target: sessionActionTarget, surface: actionMenuSurface })
            .includes(SESSION_ACTION_TALK_ID);
        const handleTalkAction = React.useCallback(() => {
            fireAndForget(executeSessionAction({ actionId: SESSION_ACTION_TALK_ID, target: sessionActionTarget })
                .catch((error: unknown) => {
                    Modal.alert(t('common.error'), error instanceof HappyError ? error.message : t('errors.unknownError'));
                }), { tag: 'SessionItem.talk' });
        }, [sessionActionTarget]);
        const { activeTags, knownTags } = React.useMemo(() => resolveSessionItemTagCollections({
            tags,
            allKnownTags,
        }), [allKnownTags, tags]);
        const [uncontrolledContextMenuOpen, setUncontrolledContextMenuOpen] = React.useState(false);
        const contextMenuOpen = nativeContextMenuOpen ?? uncontrolledContextMenuOpen;
        const setContextMenuOpen = onNativeContextMenuOpenChange ?? setUncontrolledContextMenuOpen;
        const setAttentionMenuHeld = useSessionListAttentionActivity();
        React.useLayoutEffect(() => {
            setAttentionMenuHeld(tagMenuOpen || moreMenuOpen || contextMenuOpen);
        }, [contextMenuOpen, moreMenuOpen, setAttentionMenuHeld, tagMenuOpen]);
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
                testID: `session-draft-delete:existing-session:${occurrenceTestId}`,
                title: t('sessionDrafts.delete.action'),
                icon: <Icon name="trash" size={16} color={rowActionIconColor} />,
            }];
        }, [draft, onDeleteDraft, occurrenceTestId, rowActionIconColor]);
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
            () => [...workspaceOpen.items, ...(mentionScope && mentionScope.serverId === serverId ? [{ id: 'entity.mentionInComposer', title: t('entityDragDrop.composer.mentionInComposer'),
                icon: <Icon name="at" size={16} color={rowActionIconColor} /> }] : []), ...draftMenuItems, ...copyDebugMenuItems, ...forkMenuItems, ...organizeMenuItems],
            [copyDebugMenuItems, draftMenuItems, forkMenuItems, organizeMenuItems, workspaceOpen.items, mentionScope, serverId, rowActionIconColor],
        );

        const handleSelectLeadingMenuItem = React.useCallback(async (itemId: string): Promise<boolean> => {
            if (workspaceOpen.select(itemId)) return true;
            if (itemId === 'entity.mentionInComposer' && mentionScope && mentionScope.serverId === serverId) {
                await mention({ kind: 'session', scope: mentionScope, address: { serverId, sessionId: resolvedSession.id } }, sessionNameResolved);
                return true;
            }
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
            return false;
        }, [confirmDeleteDraft, copyFeedback, mention, mentionScope, openForkFlow, organize, resolvedSession.id, resolveSessionDebugInformation, serverId, sessionNameResolved, workspaceOpen]);

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
            onOpened?.();
        }, [
            contextMenuOpen,
            navigateToSession,
            onOpened,
            resolvedSelectionKey,
            resolvedSession.id,
            rowSelection,
            serverId,
            setContextMenuOpen,
            stopRowPressPropagation,
        ]);

        const handleOpenFromMenu = React.useCallback(() => {
            navigateToSession(resolvedSession.id, serverId ? { serverId } : undefined);
            onOpened?.();
        }, [navigateToSession, onOpened, resolvedSession.id, serverId]);

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
            surface: actionMenuSurface,
            flightOriginRef: identityRef,
            onOpen: handleOpenFromMenu,
            onMoveToFolder,
            sectionMove,
            spaceMembership,
            menuOpen: moreMenuOpen || contextMenuOpen,
            selectionModeAvailable: Boolean(resolvedSelectionKey),
            selectionModeActive: rowSelection.isSelectionMode,
            onEnterSelectionMode: handleEnterSelectionMode,
            touchPrimaryPointer,
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
            touchPrimaryPointer,
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
            touchPrimaryPointer,
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

        const rowHasBackgroundWork = sessionStatus.state === 'background_active';
        const rowHasUnreadAttention = hasUnreadMessages || (rowHasBackgroundWork && hasSessionListUnreadAttention({
            hasUnreadMessages,
            personalAttentionReason: resolvedSession.viewer?.attention.primary,
        }));
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
        const collectionRowDensity = resolveCollectionRowDensity(rowDensity);
        const workFacts = sessionWorkStatusFactsFromStatus(resolvedSession, sessionStatus);
        const workStatus = resolveWorkStatusTone({
            kind: 'session',
            facts: workFacts,
        });
        const rowContextSubtitle = externalSessionIdentity?.rowMetadataLabel || sessionSubtitle;
        const currentWorkTitle = workflowOccurrence ? undefined : sessionStatus.awareness.currentWork?.title;
        const hasWorkHeadline = Boolean(currentWorkTitle)
            && isSessionAwarenessContentReadableV1(sessionStatus.awareness.encryption);
        const rowPresentation = resolveSessionRowPresentation({
            status: workStatus,
            requestRef: serverId && workFacts.currentRequestRef
                ? createCollectionSessionRequestRef({ serverId, sessionId: resolvedSession.id }, workFacts.currentRequestRef)
                : null,
            density: rowDensity,
            requestedSecondaryLineMode,
            hasPathSubtitle: Boolean(rowContextSubtitle),
            hasWorkHeadline,
            quietWhenOffline,
        });
        const rowAttentionState = workStatus.state;
        const attentionIndicatorAnimationEnabled = rowAttentionAnimationEnabled && sessionStatus.isPulsing === true;
        const standingExplanation = attentionStanding === true && workStatus.state === 'waiting'
            ? t('status.keptInAttention') : '';
        const effectiveSecondaryLineMode = standingExplanation && !isMinimal ? 'status' : rowPresentation.secondaryLine;
        const statusSummaryText = [standingExplanation || rowPresentation.statusText, externalSessionIdentity?.rowMetadataLabel]
            .filter(Boolean).join(' · ');
        const statusLineText = hasWorkHeadline
            ? `${statusSummaryText} · ${currentWorkTitle}`
            : statusSummaryText;
        const workStatusWord = workStatusWordStyle(workStatus.tone);
        // Viewer news is independent of actual background work; speaking it never reclassifies work.
        const backgroundUnreadLabel = rowHasBackgroundWork && rowHasUnreadAttention
            ? t(resolvedSession.viewer?.attention.reasons.includes('mentioned') ? 'status.mentioned' : 'status.unread')
            : undefined;
        const rowAttentionAccessibilityLabel = [rowPresentation.accessibilityStatusText, backgroundUnreadLabel, standingExplanation]
            .filter(Boolean).join(', ');
        const rowIsWorking = workStatus.bucket === 'working';
        const normalizedReportsDepth = Math.min(Math.max(Math.trunc(reportsDepth ?? 0), 0), 3);
        const reportsCollapsed = reportsDisclosure === 'collapsed';
        const liveReportCount = readSessionLiveManagedSessionCountV1(resolvedSession.managedSessions);
        const reportsChip = resolvedSession.managedSessions && hasSessionRowReportsChip(resolvedSession.managedSessions)
            ? <SessionRowReportsChip sessionId={resolvedSession.id} occurrenceId={occurrenceId} reports={resolvedSession.managedSessions} />
            : null;
        const reportsDisclosureControl = reportsDisclosure && onSetReportsCollapsed ? (
            <SessionRowReportsDisclosure
                sessionId={resolvedSession.id}
                occurrenceId={occurrenceId}
                nodeId={occurrenceId ?? buildSessionListIndexNodeId({ type: 'session', serverId, sessionId: resolvedSession.id })}
                name={sessionNameResolved}
                count={liveReportCount}
                collapsed={reportsCollapsed}
                onSetCollapsed={onSetReportsCollapsed}
            />
        ) : null;
        // The one derivation the Only-coordinators filter uses; the row reads it, never a stored flag.
        const isCoordinator = deriveSessionCoordinatorV1(resolvedSession) === true;
        const reportsAccessibilityLabel = [
            normalizedReportsDepth > 0 ? t('sessionWork.list.level', { level: normalizedReportsDepth + 1 }) : null,
            isCoordinator ? t('sessionWork.list.coordinator') : null,
            liveReportCount > 0
                ? t('sessionWork.list.subSessions', { count: liveReportCount })
                : null,
        ].filter(Boolean).join('. ');
        const rowAccessibilityLabel = [sessionNameResolved, rowContext?.accessibleLabel, reportsAccessibilityLabel, rowAttentionAccessibilityLabel]
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
        const rowStatusMark = resolveWorkStatusRowMark(workStatus);
        // The opt-in needs-you highlight (owner ruling 2026-11-01): only a row that needs the person, outside the
        // Needs you shelf; its motion stops once the row is opened (its news read) and runs only while on screen.
        const needsYouHighlighted = isWorkStatusNeedsYou(workStatus) && inAttentionShelf !== true;
        const needsYouHighlight = React.useMemo(() => needsYouHighlighted
            ? { unopened: rowHasUnreadAttention, visible: rowAttentionAnimationEnabled !== false } : null,
        [needsYouHighlighted, rowAttentionAnimationEnabled, rowHasUnreadAttention]);
        // Status words (the Account's `session.list.statusWords`, opt-in): a state with a word of its own says it,
        // in its tone, before its mark; a calm row then shows its word instead of its age.
        const showTrailingStatusWord = isMinimal && rowContext?.statusWords === true && Boolean(workStatus.word)
            && Boolean(workStatus.glyph);
        const showTrailingAttentionIndicator = isMinimal && (rowStatusMark !== 'none' || showTrailingStatusWord);
        // One status slot (calm ruling 2026-11-01): the row's mark, or its age when the row is calm.
        const trailingAttentionReplacesTime = showTrailingAttentionIndicator;
        const trailingStatusWord = showTrailingStatusWord ? (
            <WorkStatusRowWord status={workStatus} seed={resolvedSession.id}>{(word) => (
                <Text testID={`session-list-status-word-${occurrenceTestId}`} variant="meta" numberOfLines={1}
                    style={[styles.trailingStatusWord, workStatusWord ?? styles.statusTextQuiet]}>
                    {word}
                </Text>
            )}</WorkStatusRowWord>
        ) : null;
        const trailingStatusGlyph = showTrailingAttentionIndicator ? (
            <View style={styles.trailingStatusGroup}>
                {trailingStatusWord}
                <WorkStatusRowMark
                    status={workStatus}
                    testIDSuffix={`${occurrenceTestId}-trailing`}
                    hasUnreadMessages={rowHasUnreadAttention}
                    animationEnabled={attentionIndicatorAnimationEnabled}
                    needsYouHighlight={needsYouHighlight}
                />
            </View>
        ) : null;
        // An amber slot answers (lab `clstatus`): it opens the request itself, beside the row's navigation.
        const trailingStatusSlot = trailingStatusGlyph && rowPresentation.requestRef ? (
            <CollectionRequestPeek
                request={rowPresentation.requestRef}
                description={sessionNameResolved}
                testID={`session-row-request-peek-${occurrenceTestId}`}
            >
                {trailingStatusGlyph}
            </CollectionRequestPeek>
        ) : trailingStatusGlyph;
        const showTrailingGuardWord = Boolean(guardState) && !trailingAttentionReplacesTime;
        const showTrailingActivityTime = Boolean(activityTimeLabel) && !trailingAttentionReplacesTime && !showTrailingGuardWord;
        const hasTrailingMeta = showTrailingAttentionIndicator || showTrailingActivityTime || showTrailingGuardWord;
        // Auto and every Agent- or Project-led choice lead with the Agent's mark (lab `clctx:marks`) until the
        // row's Project favicon reaches it; an explicit Avatar or None stays as chosen.
        // The list's row context resolves the person's full choice per row (P5); other hosts keep their own.
        const storedIdentityDisplay: string = rowContext ? rowContext.leadingMark : sessionListIdentityDisplay;
        const resolvedSessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'project' | 'projectWithAgent' | 'none' =
            storedIdentityDisplay === 'none' || storedIdentityDisplay === 'avatar'
                || storedIdentityDisplay === 'project' || storedIdentityDisplay === 'projectWithAgent'
                ? storedIdentityDisplay : 'agentLogo';
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
            readableNativePhoneMinimal: touchCompactRow,
        });
        const avatarSize = identityMetrics.slotSize;
        const agentLogoSize = identityMetrics.agentLogoSize;
        const identityTitleLoadingStyle = isMinimal
            ? styles.sessionTitleLoadingMinimal
            : compact
                ? styles.sessionTitleLoadingCompact
                : styles.sessionTitleLoading;
        const sessionTitleColorRole = resolveSessionRowTitleColorRole({
            mode: normalizeSessionListActiveColorMode(sessionListActiveColorMode),
            selected: selected === true || rowSelection.isSelected,
            isSessionActive: resolvedSession.active === true,
            status: workStatus,
            titleTone: rowPresentation.titleTone,
            roster: actionMenuSurface === 'botsRoster',
            unread: rowHasUnreadAttention,
        });
        const sessionTitleColor = sessionRowTitleInk(theme.colors, sessionTitleColorRole);
        const renderTagChipRow = (placement: 'below' | 'inline') => (
            <View
                testID={`session-item-tags-${placement}-${occurrenceTestId}`}
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
                        <Text style={styles.tagChipText} numberOfLines={1}>
                            {tag.label}
                        </Text>
                    </View>
                ))}
            </View>
        );
        const itemContent = (
            <CollectionRowContent
                density={collectionRowDensity}
                touchCompact={touchCompactRow}
                textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                selected={Boolean(selected || rowSelection.isSelected)}
                hovered={isWeb && isRowHovered && isBeingDragged !== true}
                onLayout={sourceTagChips.length > 0 ? handleRowLayout : undefined}
                leading={<>
                    {needsYouHighlight ? (
                        <CollectionRowNeedsYouLeading {...needsYouHighlight} testID={`session-row-needs-you-highlight-${occurrenceTestId}`} />
                    ) : null}
                    {normalizedReportsDepth > 0 ? (
                        <View
                            testID={`session-list-item-reports-gutter-${occurrenceTestId}`}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={[styles.reportsGutter, { width: normalizedReportsDepth * SESSION_REPORTS_ROW_INDENT_STEP }]}
                        >
                            <View style={styles.reportsConnector} />
                        </View>
                    ) : null}
                    {reportsDisclosureControl}
                </>}
                renderContainer={(content, rowStyle) => (
                    // When the list carries this row itself, that is its one drag (it reaches panes too). The
                    // wrapper takes the press target's flex slot, so a long title truncates and the meta stays in view.
                    <WorkspaceDestinationRow existingMenu onOpenExistingMenu={() => setMoreMenuOpen(true)} dragSource={!dragEnabled} style={rowStyle} href={buildScopedSessionRouteHref({
                        sessionId: resolvedSession.id, serverId: serverId ?? null,
                    })}>
                    <Pressable
                        ref={followEditor.triggerRef}
                        testID={`session-list-item-${occurrenceTestId}`}
                        accessibilityRole="button"
                        accessibilityLabel={rowAccessibilityLabel}
                        accessibilityState={{
                            selected: Boolean(selected || rowSelection.isSelected),
                            busy: rowIsWorking,
                        }}
                        aria-pressed={Platform.OS === 'web' ? Boolean(selected || rowSelection.isSelected) : undefined}
                        aria-busy={Platform.OS === 'web' ? rowIsWorking : undefined}
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
                        {content}
                    </Pressable>
                    </WorkspaceDestinationRow>
                )}
                identity={shouldRenderSessionListIdentity || shouldRenderSelectionCheckbox ? (
                    <>
                        {shouldRenderSelectionCheckbox ? (
                            <SessionListSelectionCheckbox
                                sessionId={resolvedSession.id}
                                occurrenceId={occurrenceId}
                                selectionKey={resolvedSelectionOccurrenceKey}
                                selected={rowSelection.isSelected}
                                onPress={rowSelection.toggle}
                                style={{ width: avatarSize, height: avatarSize }}
                            />
                        ) : isSessionIdentityLoading ? (
                            <View
                                testID={`session-list-avatar-loading-${occurrenceTestId}`}
                                style={[
                                    isMinimal
                                        ? touchCompactRow
                                            ? styles.avatarLoadingMinimalNativePhone
                                            : styles.avatarLoadingMinimal
                                        : compact
                                            ? styles.avatarLoadingCompact
                                            : styles.avatarLoading,
                                ]}
                            />
                        ) : (
                            <View ref={identityRef} collapsable={false}>
                                <SessionListIdentity
                                    session={resolvedSession}
                                    display={resolvedSessionListIdentityDisplay}
                                    projectFavicon={rowProjectFavicon}
                                    serverId={serverId ?? null}
                                    color={sessionTitleColor}
                                    avatarSize={avatarSize}
                                    agentLogoSize={agentLogoSize}
                                    connected={sessionStatus.isConnected}
                                                                                    testID={`session-list-agent-logo-${occurrenceTestId}`}
                                />
                            </View>
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
                        {!isMinimal && shouldRenderSessionListAvatar && draft && draftPreview ? (
                            <SessionRowDraftIndicator
                                source={draftPreview}
                                rowTestID={`session-list-draft-indicator:${occurrenceTestId}`}
                                style={[styles.draftIconContainer, compact ? styles.draftIconContainerCompact : null]}
                                iconSize={compact ? 11 : 12}
                                iconColor={theme.colors.text.secondary}
                            />
                        ) : null}
                    </>
                ) : null}
                title={<>
                        {isSessionIdentityLoading ? (
                            <View
                                testID={`session-list-title-loading-${occurrenceTestId}`}
                                style={[
                                    identityTitleLoadingStyle,
                                ]}
                            />
                        ) : (
                            <CollectionRowTitle
                                density={collectionRowDensity}
                                touchCompact={touchCompactRow}
                                textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                                emphasis={selected || rowSelection.isSelected || rowHasUnreadAttention ? 'semiBold' : shouldEmphasizeTitle ? 'medium' : undefined}
                                color={sessionTitleColor}
                            >
                                {sessionNameResolved}
                            </CollectionRowTitle>
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
                                testID={`session-list-reminder-indicator:${occurrenceTestId}`}
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
                        {/* Where it runs, beyond what its group implies (lab `clctx`): Project and branch. */}
                        {rowContext && !showStandardSecondaryLine && !isSessionIdentityLoading ? (
                            <>
                                {rowContext.project && !(rowContext.project.yieldsToFavicon && rowProjectFavicon) ? (
                                    <CollectionRowBadge testID={`session-list-row-context-project-${occurrenceTestId}`}
                                        label={rowContext.project.label} />
                                ) : null}
                                {rowContext.checkout ? (
                                    <CollectionRowBadge testID={`session-list-row-context-checkout-${occurrenceTestId}`}
                                        icon={rowContext.checkout.kind === 'branch' ? 'git-branch' : 'folder'} label={rowContext.checkout.label} />
                                ) : null}
                            </>
                        ) : null}
                        {/* A lead's progress hugs its title (lab `clgroups` coordinator: "3/5 done"). */}
                        {reportsChip}
                </>}
                children={<>
                    {draft && draftPreview && !compact && draft.hasPreview ? (
                        <SessionRowDraftPreviewLine
                            source={draftPreview}
                            rowTestID={`session-list-draft-preview:${occurrenceTestId}`}
                            density={collectionRowDensity}
                            textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                        />
                    ) : showStandardSecondaryLine ? (
                        shouldShowIdentitySubtitleSkeleton ? (
                            <View
                                testID={`session-list-subtitle-loading-${occurrenceTestId}`}
                                style={[
                                    compact ? styles.sessionSubtitleLoadingCompact : styles.sessionSubtitleLoading,
                                ]}
                            />
                        ) : effectiveSecondaryLineMode === 'status' ? (
                            <View
                                testID={`session-list-status-subtitle-${occurrenceTestId}-${rowAttentionState}`}
                                style={styles.secondaryLineRow}
                            >
                                <View style={styles.secondaryStatusDotContainer}>
                                    {rowStatusMark !== 'none' ? (
                                        <WorkStatusRowMark
                                            status={workStatus}
                                            testIDSuffix={`${occurrenceTestId}-secondary`}
                                            hasUnreadMessages={rowHasUnreadAttention}
                                            animationEnabled={attentionIndicatorAnimationEnabled}
                                            needsYouHighlight={needsYouHighlight}
                                        />
                                    ) : null}
                                </View>
                                <Text
                                    testID={`session-list-status-subtitle-text-${occurrenceTestId}-${rowAttentionState}`}
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
                            <CollectionRowLine
                                density={collectionRowDensity}
                                textScale={typeof uiFontScale === 'number' ? uiFontScale : undefined}
                                style={shouldUseWebPathSubtitleStartEllipsis ? styles.sessionPathSubtitleWeb : null}
                                ellipsizeMode={shouldUseWebPathSubtitleStartEllipsis ? undefined : effectiveSubtitleEllipsizeMode}
                            >
                                {shouldUseWebPathSubtitleStartEllipsis ? (
                                    <Text style={styles.sessionPathSubtitleTextWeb}>
                                        {rowContextSubtitle}
                                    </Text>
                                ) : rowContextSubtitle}
                            </CollectionRowLine>
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
                        testID={`session-item-copy-debug-feedback:${occurrenceTestId}`}
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
                                            rowContainerStyle: { paddingVertical: theme.space.s6 },
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
                                            <IconButton
                                                testID="session-item-tag-action"
                                                {...rowActionButtonProps}
                                                onPress={(e) => {
                                                    stopRowPressPropagation(e);
                                                    setTagMenuEverOpened(true);
                                                    toggle();
                                                }}
                                                accessibilityLabel={t('sessionTags.editTagsLabel')}
                                                icon={<TagIcon size={14} color={rowActionIconColor} />}
                                            />
                                        )}
                                    />
                                ) : (
                                    <IconButton
                                        testID="session-item-tag-action"
                                        {...rowActionButtonProps}
                                        onPress={(e) => {
                                            stopRowPressPropagation(e);
                                            setTagMenuEverOpened(true);
                                            setTagMenuOpen(true);
                                        }}
                                        accessibilityLabel={t('sessionTags.editTagsLabel')}
                                        icon={<TagIcon size={14} color={rowActionIconColor} />}
                                    />
                                )
                            ) : null}
                            {talkActionVisible ? (
                                <IconButton
                                    testID="session-item-talk-action"
                                    {...rowActionButtonProps}
                                    onPress={(e) => {
                                        stopRowPressPropagation(e);
                                        handleTalkAction();
                                    }}
                                    accessibilityLabel={t('bots.talk', { name: sessionNameResolved })}
                                    icon={<Icon name="microphone" size={14} color={rowActionIconColor} />}
                                />
                            ) : null}
                            {supportsPin ? (
                                <IconButton
                                    testID="session-item-pin-action"
                                    {...rowActionButtonProps}
                                    onPress={(e) => {
                                        stopRowPressPropagation(e);
                                        handleTogglePinnedAction();
                                    }}
                                    accessibilityLabel={pinned ? t('sessionInfo.unpinSession') : t('sessionInfo.pinSession')}
                                    icon={pinned ? (
                                        <PinSlashIcon size={14} color={rowActionIconColor} />
                                    ) : (
                                        <PinIcon size={14} color={rowActionIconColor} />
                                    )}
                                />
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
                                    maxWidthCap={260}
                                    showCategoryTitles={false}
                                    popoverPortalWebTarget="body"
                                    trigger={({ toggle }) => (
                                        <IconButton
                                            testID="session-item-more-menu"
                                            {...rowActionButtonProps}
                                            onPress={(e) => {
                                                stopRowPressPropagation(e);
                                                toggle();
                                            }}
                                            accessibilityLabel={t('common.moreActions')}
                                            icon={<Icon name="dots-three" size={14} color={rowActionIconColor} />}
                                        />
                                    )}
                                />
                            ) : null}
                            {showTrailingAttentionIndicator && workStatus.tone !== 'neutral' ? trailingStatusSlot : null}
                        </View>
                    ) : showTrailingAttentionIndicator || showTrailingActivityTime || showTrailingGuardWord ? (
                        <View style={styles.trailingMetaRow}>
                            {showTrailingAttentionIndicator ? trailingStatusSlot : null}
                            {showTrailingActivityTime || showTrailingGuardWord ? (
                                <WordCrossFade wordKey={showTrailingGuardWord && guardState ? guardState.kind : 'time'}>
                                    {showTrailingGuardWord && guardState ? (
                                        <SessionRowGuardWord guardState={guardState} />
                                    ) : (
                                        <Text
                                            style={styles.activityTime}
                                            numberOfLines={1}
                                        >
                                            {activityTimeLabel}
                                        </Text>
                                    )}
                                </WordCrossFade>
                            ) : null}
                        </View>
                    ) : null}
                    {showDragGrip && dragGripGesture ? (
                        <GestureDetector gesture={dragGripGesture}>
                            <EntityDragGrip
                                density="touch"
                                active={isBeingDragged === true}
                                accessibilityLabel={t('entityDragDrop.organize.grip', { item: sessionNameResolved })}
                                testID={`session-item-drag-grip-${occurrenceTestId}`}
                            />
                        </GestureDetector>
                    ) : null}
                </>}
            />
        );

        // Sections are flat Account filing (P5): their rows keep the column's row edge, like every group's.
        const containerStyles = [
            embedded ? styles.sessionItemContainerEmbedded : styles.sessionItemContainer,
        ];

        const menuNodes = touchPrimaryPointer ? (
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
                            rowContainerStyle: { paddingVertical: theme.space.s6 },
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
                <GlassSurface
                    ref={contextMenuAnchorRef}
                    collapsable={false}
                    surfaceGroup={embedded ? containingGroup ?? 'card' : 'card'}
                    nested
                    enabled={embedded === true && containingGroup !== null}
                    solidColor="transparent"
                    finishRole={null}
                    style={containerStyles}
                    onPointerEnter={isWeb ? handleRowPointerEnter : undefined}
                    onPointerLeave={isWeb ? handleRowPointerLeave : undefined}
                >
                    {itemContent}
                    {menuNodes}
                    {followEditor.editor}
                </GlassSurface>
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
            <GlassSurface
                ref={contextMenuAnchorRef}
                collapsable={false}
                surfaceGroup={embedded ? containingGroup ?? 'card' : 'card'}
                nested
                enabled={embedded === true && containingGroup !== null}
                solidColor="transparent"
                finishRole={null}
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
            </GlassSurface>
        );
    },
);

/** The row's guard word (lab `rg` G3-2): amber "Stops in 4:52" while Keep running is still possible; a quiet moon after. */
function SessionRowGuardWord(props: Readonly<{ guardState: SessionListGuardState }>) {
    const { theme } = useUnistyles();
    if (props.guardState.kind === 'stopping') {
        return (
            <GuardCountdown stopAt={props.guardState.stopAt} testID="session-row-guard-stops"
                style={[stylesheet.activityTime, { color: theme.colors.state.attention.textForeground }]}
                format={duration => t('machineGuard.session.stopsIn', { duration })} />
        );
    }
    return (
        <View testID="session-row-guard-stopped" style={stylesheet.trailingMetaRow}>
            <Icon name="moon" size={11} color={theme.colors.text.tertiary} />
            <Text style={stylesheet.activityTime} numberOfLines={1}>{t('machineGuard.session.stopped')}</Text>
        </View>
    );
}

/** Typing changes only these two leaves of a row: the row's structure follows `draft`, never its text. */
function SessionRowDraftIndicator(props: Readonly<{
    source: SessionListRowDraftPreviewSource;
    rowTestID: string;
    style: StyleProp<ViewStyle>;
    iconSize: number;
    iconColor: string;
}>) {
    const preview = useSessionListRowDraftPreview(props.source);
    return (
        <View
            testID={props.rowTestID}
            accessibilityRole="text"
            accessibilityLabel={preview ? `${t('sessionDrafts.badge')}, ${preview}` : t('sessionDrafts.badge')}
            accessibilityHint={t('sessionDrafts.continueEditing')}
            style={props.style}
        >
            <Icon name="pencil-simple" size={props.iconSize} color={props.iconColor} />
        </View>
    );
}

function SessionRowDraftPreviewLine(props: Readonly<{
    source: SessionListRowDraftPreviewSource;
    rowTestID: string;
} & Omit<React.ComponentProps<typeof CollectionRowLine>, 'children' | 'testID'>>) {
    const { source, rowTestID, ...lineProps } = props;
    const preview = useSessionListRowDraftPreview(source);
    return <CollectionRowLine {...lineProps} testID={rowTestID}>{`${t('sessionDrafts.badge')} · ${preview}`}</CollectionRowLine>;
}

function SessionItemFromRowViewModel(props: SessionItemProps) {
    const { theme } = useUnistyles();
    const { rowViewModel, ...itemProps } = props;
    const rowSession = rowViewModel.session;
    const rowStatus = rowViewModel.sessionStatus;
    const archivePending = useSessionArchivePending(normalizeSessionAddress(itemProps.serverId, rowSession?.id));
    if (!rowSession || !rowStatus) {
        return null;
    }
    const session = resolveSessionItemEffectiveSession({
        rowSession,
        providedSession: itemProps.session,
    });
    const sessionStatus = archivePending || rowStatus.state === 'archiving' || session !== rowSession
        ? getSessionStatus(session, Date.now(), {
            archiving: archivePending,
            statusColors: theme.colors.status,
        }) : rowStatus;
    const contentUnavailable = !isSessionAwarenessContentReadableV1(sessionStatus.awareness.encryption);
    // Encryption pending is not a reason to forget a name this device already holds:
    // the owner keeps a safe cached title and falls back only when none exists, so the
    // list row and the detail header call the same Session the same thing. Handing it
    // an empty string discarded that title and made every locked row anonymous.
    const sessionNameResolved = sessionDisplayTitle(session, itemProps.serverId);

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
            secondaryLineMode={itemProps.secondaryLineMode ?? rowViewModel.secondaryLineMode}
            activityTimeLabel={rowViewModel.activityTimeLabel}
            guardState={rowViewModel.guardState}
            sessionStatus={sessionStatus}
            externalSessionIdentity={rowViewModel.externalSessionIdentity}
            sessionNameResolved={sessionNameResolved}
            sessionSubtitle={contentUnavailable ? '' : itemProps.subtitleOverride ?? rowViewModel.subtitleOverride ?? getSessionSubtitle(session, itemProps.serverId)}
            isSessionIdentityLoading={rowViewModel.isIdentityLoading}
            hasUnreadMessages={rowViewModel.hasUnreadMessages}
            attentionStanding={rowViewModel.attentionStanding}
            isAttentionStanding={rowViewModel.isAttentionStanding}
            attentionStandingEnabled={rowViewModel.attentionStandingEnabled}
            rowAttentionAnimationEnabled={itemProps.rowAttentionAnimationEnabled !== false}
            sessionListIdentityDisplay={normalizeSessionListIdentityDisplay(rowViewModel.identityDisplay)}
            sessionListActiveColorMode={normalizeSessionItemActiveColorMode(rowViewModel.activeColorMode)}
            hideInactiveSessions={itemProps.hideInactiveSessions ?? rowViewModel.hideInactiveSessions}
            draft={rowViewModel.draft}
            reminder={rowViewModel.reminder}
            rowContext={rowViewModel.rowContext}
        />
    );
}

export const SessionItem = React.memo(function SessionItem(props: SessionItemProps | WorkflowRunItemProps) {
    const resolveMaterialColor = useGlassMaterialColorResolver('card');
    const containingRole = useContainingHappierMaterialRole();
    if ('kind' in props && props.kind === 'workflow_run') return <HappierMaterialRoleProvider role="card" resolveMaterialColor={resolveMaterialColor}><WorkflowRunItemBody {...props} /></HappierMaterialRoleProvider>;
    if (!('rowViewModel' in props)) return null;
    if (!props.rowViewModel) return null;
    // Publish the sheet role before the body derives chip/skeleton paint; embedded rows
    // keep their containing plane. GlassSurface still owns the actual coat and backdrop.
    return <HappierMaterialRoleProvider role={props.embedded ? containingRole : 'card'} resolveMaterialColor={props.embedded ? undefined : resolveMaterialColor}><SessionItemFromRowViewModel {...props} /></HappierMaterialRoleProvider>;
});
