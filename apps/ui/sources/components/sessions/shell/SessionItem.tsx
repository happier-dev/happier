import React from 'react';
import { Animated, Platform, Pressable, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, Swipeable, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Text, Text as RNText } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import {
    DEFAULT_AGENT_ID,
    getAgentCore,
    getAgentPickerIconScale,
    resolveAgentIdFromFlavor,
} from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { Typography } from '@/constants/Typography';
import { formatPendingCountBadge } from '@/components/sessions/pendingBadge';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { t } from '@/text';
import type { SessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import { Session } from '@/sync/domains/state/storageTypes';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionAvatarId } from '@/utils/sessions/sessionUtils';
import { PinIcon, PinSlashIcon } from './sessionPinIcons';
import { TagIcon } from './sessionTagIcons';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { SessionRowAttentionIndicator } from './row/SessionRowAttentionIndicator';
import type { SessionRowAttentionState, SessionRowPresentation } from './row/resolveSessionRowPresentation';
import type { SessionListRowModel } from './row/sessionListRowModelTypes';
import {
    normalizeSessionListActiveColorMode,
    resolveSessionRowTitleColorRole,
} from './row/sessionRowTitleColorRole';
import { resolveSessionRowAttentionStateColor } from './row/sessionRowAttentionColors';
import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
} from './sessionListRowHeights';
import {
    SESSION_LIST_ROW_CORNER_RADIUS,
    resolveSessionListRowIdentityMetrics,
    SESSION_LIST_ROW_IDENTITY_METRICS,
    SESSION_LIST_ROW_STATUS_TEXT_METRICS,
    SESSION_LIST_ROW_TITLE_TEXT_METRICS,
    shouldUseReadableNativePhoneMinimalSessionRow,
} from './sessionListRowDensity';
import { planSessionTagDisplay } from './sessionTagPlacement';
import { useIsTablet } from '@/utils/platform/responsive';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';
import { useSessionRowActionMenu } from './row/actionMenu/useSessionRowActionMenu';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
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
import {
    buildSessionDebugInformation,
    isSessionDebugInformationEnabled,
    resolveProviderSessionIdForDebug,
} from '@/components/sessions/debug/sessionDebugInformation';
import { copySessionDebugInformationToClipboard } from '@/components/sessions/debug/sessionDebugClipboard';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import {
    createCopySessionDebugInformationMenuItem,
    SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID,
} from '@/components/sessions/debug/sessionDebugMenuItem';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { canForkConversation } from '@/sync/domains/sessionFork/forkUiSupport';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { resolveMachineTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { SessionForkReplaySettingsSource } from '@/sync/domains/sessionFork/resolveSessionForkReplayOptions';

const SESSION_LIST_MINIMAL_IDENTITY_GAP = 8;
const CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS = 600;
const CONTEXT_MENU_PRESS_IN_OPEN_DELAY_MS = 350;
const CONTEXT_MENU_DEFERRED_ACTION_DELAY_MS = 0;
const SESSION_IDENTITY_SKELETON_ANIMATION_MS = 900;
const SESSION_FOLDER_ROW_CHROME_INDENT_BASE = 38;
const SESSION_FOLDER_ROW_CHROME_INDENT_STEP = 12;
const SESSION_FOLDER_ROW_INDENT_CAP = 3;
const SESSION_DELETE_DRAFT_MENU_ITEM_ID = 'session-draft.delete';

type SessionItemActivityTimeMode = 'meaningful' | 'updatedAt';
type SessionItemIdentityDisplay = 'avatar' | 'agentLogo' | 'none';
type SessionItemActiveColorMode = 'activityAndAttention' | 'attentionOnly' | 'allActive';
type SessionItemWorkingIndicatorMode = 'spinner' | 'pulse';

type SessionItemBaseProps = Readonly<{
    embedded?: boolean;
    embeddedIsLast?: boolean;
    session: Session | SessionListRenderableSession;
    selectionKey?: string | null;
    subtitleOverride?: string | null;
    subtitleEllipsizeMode?: 'head' | 'tail';
    serverId?: string;
    serverName?: string;
    currentUserId?: string | null;
    showServerBadge?: boolean;
    pinned?: boolean;
    onTogglePinned?: (() => void) | null;
    onDeleteDraft?: (() => void | Promise<void>) | null;
    attentionStandingEnabled?: boolean;
    attentionStanding?: boolean;
    tags?: readonly string[];
    allKnownTags?: readonly string[];
    onSetTags?: ((newTags: string[]) => void) | null;
    tagsEnabled?: boolean;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    variant?: 'default' | 'no-path';
    secondaryLineMode?: SessionListSecondaryLineMode;
    activityTimeMode?: SessionItemActivityTimeMode;
    compact?: boolean;
    compactMinimal?: boolean;
    reorderHandleGesture?: GestureType | ComposedGesture;
    isBeingDragged?: boolean;
    nativeInlineDragEnabled?: boolean;
    nativeContextMenuOpen?: boolean;
    onNativeContextMenuOpenChange?: (next: boolean) => void;
    rowAttentionAnimationEnabled?: boolean;
    folderDepth?: number;
    folderMoveMenuItems?: readonly DropdownMenuItem[];
    onMoveDown?: () => void;
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onSelectFolderMoveMenuItem?: (itemId: string) => void;
    forkActionContext?: Readonly<{
        settings: SessionForkReplaySettingsSource | null;
        replayEnabled: boolean;
        executionRunsEnabled: boolean;
    }>;
}>;

export type SessionItemProps = SessionItemBaseProps & Readonly<{
    rowModel: SessionListRowModel;
    hideInactiveSessions?: boolean;
}>;

type SessionItemRenderProps = Omit<SessionItemBaseProps, 'activityTimeMode' | 'subtitleOverride'> & Readonly<{
    sessionStatus: SessionStatus;
    sessionNameResolved: string;
    sessionSubtitle: string;
    pendingCount: number;
    draft: SessionListRowModel['draft'];
    /** Live agent work in this session, already named. `null` unless the person opted in (R-8). */
    agentActivityLabel: string | null;
    isSessionIdentityLoading: boolean;
    activityTimeLabel: string;
    rowAttentionState: SessionRowAttentionState;
    rowPresentation: SessionRowPresentation;
    workingIndicatorMode: SessionItemWorkingIndicatorMode;
    workingIndicatorPaused?: boolean;
    rowAttentionAnimationEnabled: boolean;
    sessionListIdentityDisplay: SessionItemIdentityDisplay;
    sessionListActiveColorMode: SessionItemActiveColorMode;
    hideInactiveSessions: boolean;
}>;

function normalizeSessionItemIdentityDisplay(value: unknown): SessionItemIdentityDisplay {
    return value === 'agentLogo' || value === 'none' ? value : 'avatar';
}

function normalizeSessionItemActiveColorMode(value: unknown): SessionItemActiveColorMode {
    switch (value) {
        case 'attentionOnly':
        case 'allActive':
            return value;
        case 'activityAndAttention':
        default:
            return 'activityAndAttention';
    }
}

function normalizeSessionItemWorkingIndicatorMode(value: unknown): SessionItemWorkingIndicatorMode {
    return value === 'pulse' ? 'pulse' : 'spinner';
}

const stylesheet = StyleSheet.create((theme) => ({
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'hidden',
    },
    sessionItemContainerEmbedded: {
        marginHorizontal: 0,
        marginBottom: 0,
        overflow: 'hidden',
    },
    sessionItemContainerFirst: {
        borderTopLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        marginBottom: 12,
    },
    sessionItemContainerSingle: {
        borderRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        marginBottom: 12,
    },
    sessionItem: {
        height: SESSION_LIST_ROW_HEIGHT_DEFAULT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 15,
        backgroundColor: theme.colors.surface.base,
        borderLeftWidth: 2,
        borderRightWidth: 2,
        borderColor: theme.colors.surface.base,
    },
    sessionItemFirst: {
        borderTopLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopWidth: 2,
    },
    sessionItemLast: {
        borderBottomLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomWidth: 2,
    },
    embeddedSeparator: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    sessionItemCompact: {
        height: SESSION_LIST_ROW_HEIGHT_COMPACT,
        paddingHorizontal: 13,
    },
    sessionItemMinimal: {
        height: SESSION_LIST_ROW_HEIGHT_MINIMAL,
        paddingHorizontal: 8,
    },
    sessionItemMinimalNativePhone: {
        height: SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surface.selected,
        borderColor: theme.dark ? theme.colors.surface.selected : theme.colors.surface.base,
    },
    sessionTitleSelected: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    avatarContainer: {
        position: 'relative',
        width: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarContainerCompact: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
    },
    avatarContainerMinimal: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
    },
    avatarContainerMinimalNativePhone: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
    },
    avatarLoading: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
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
    avatarLoadingCompact: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
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
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconContainerCompact: {
        width: 14,
        height: 16,
        bottom: -1,
        right: -1,
    },
    draftBadge: {
        alignItems: 'center',
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
        flexDirection: 'row',
        gap: 3,
        maxWidth: 88,
        paddingHorizontal: 6,
        paddingVertical: 2,
    },
    draftBadgeCompact: {
        maxWidth: 64,
        paddingHorizontal: 4,
        paddingVertical: 1,
    },
    draftBadgeMinimal: {
        maxWidth: 22,
        paddingHorizontal: 3,
    },
    draftBadgeText: {
        color: theme.colors.text.secondary,
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
    draftPreviewText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default(),
    },
    sessionContent: {
        flex: 1,
        marginLeft: 14,
        justifyContent: 'center',
    },
    sessionContentCompact: {
        marginLeft: 12,
    },
    sessionContentMinimal: {
        marginLeft: 0,
    },
    sessionContentMinimalWithIdentity: {
        marginLeft: SESSION_LIST_MINIMAL_IDENTITY_GAP,
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 1,
        gap: 6,
    },
    sessionTitle: {
        ...SESSION_LIST_ROW_TITLE_TEXT_METRICS.default,
        flex: 1,
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    sessionTitleCompact: {
        ...SESSION_LIST_ROW_TITLE_TEXT_METRICS.compact,
    },
    sessionTitleMinimal: {
        ...SESSION_LIST_ROW_TITLE_TEXT_METRICS.minimal,
    },
    sessionTitleMinimalNativePhone: {
        ...SESSION_LIST_ROW_TITLE_TEXT_METRICS.minimalNativePhone,
    },
    sessionTitleEmphasized: {
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text.primary,
    },
    sessionTitleDisconnected: {
        color: theme.colors.text.secondary,
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
    rightArea: {
        marginLeft: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
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
    sessionSubtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        lineHeight: 16,
        ...Typography.default(),
    },
    sessionPathSubtitleWeb: {
        ...WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    },
    sessionPathSubtitleTextWeb: {
        ...WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
    },
    sessionSubtitleCompact: {
        fontSize: 11,
        lineHeight: 14,
    },
    sessionSubtitleMinimal: {
        fontSize: 10,
        lineHeight: 12,
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
    secondaryStatusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 12,
        height: 12,
    },
    secondaryStatusDotContainerCompact: {
        width: 11,
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
    agentActivityCountText: {
        // Never truncated away by a long status: the count is the shortest thing on this line and
        // the reason the person turned it on.
        flexShrink: 0,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    statusTextMinimal: {
        ...SESSION_LIST_ROW_STATUS_TEXT_METRICS.minimal,
    },
    activityTime: {
        fontSize: 10,
        color: theme.colors.text.secondary,
        ...Typography.default(),
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
        selectionKey,
        subtitleEllipsizeMode,
        serverId,
        serverName,
        currentUserId,
        showServerBadge,
        pinned,
        onTogglePinned,
        onDeleteDraft,
        attentionStandingEnabled,
        attentionStanding,
        tags,
        allKnownTags,
        onSetTags,
        tagsEnabled,
        selected,
        isFirst,
        isLast,
        isSingle,
        variant,
        secondaryLineMode,
        compact,
        compactMinimal,
        reorderHandleGesture,
        isBeingDragged,
        nativeInlineDragEnabled,
        nativeContextMenuOpen,
        onNativeContextMenuOpenChange,
        folderDepth,
        folderMoveMenuItems,
        onMoveDown,
        onMoveToFolder,
        onMoveToWorkspaceRoot,
        onMoveUp,
        onSelectFolderMoveMenuItem,
        forkActionContext,
        sessionStatus,
        sessionNameResolved,
        sessionSubtitle,
        pendingCount,
        draft,
        agentActivityLabel,
        isSessionIdentityLoading,
        activityTimeLabel,
        rowAttentionState,
        rowPresentation,
        workingIndicatorMode,
        workingIndicatorPaused,
        rowAttentionAnimationEnabled,
        sessionListIdentityDisplay,
        sessionListActiveColorMode,
        hideInactiveSessions,
    }: SessionItemRenderProps) => {
        const styles = stylesheet;
        const { theme } = useUnistyles();
        const resolvedSession = session;
        // Retained-working rows show the working indicator frozen: the
        // session is held in the working group while its live signals are
        // stale, so animating would misrepresent live activity.
        const attentionIndicatorAnimationEnabled = rowAttentionAnimationEnabled && workingIndicatorPaused !== true;
        const localDevModeEnabled = useLocalSetting('devModeEnabled');
        const devModeEnabled = isSessionDebugInformationEnabled(localDevModeEnabled);
        const router = useRouter();
        const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching', {
            scopeKind: 'spawn',
            serverId: serverId ?? null,
        });
        const resolvedSelectionKey = selectionKey ?? '';
        const rowSelection = useOptionalSessionListSelectionRow(resolvedSelectionKey);
        const identitySkeletonOpacity = React.useRef(new Animated.Value(0.45)).current;
        React.useEffect(() => {
            if (!isSessionIdentityLoading) return;
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
        }, [isSessionIdentityLoading, identitySkeletonOpacity]);
        const navigateToSession = useNavigateToSession();
        const swipeableRef = React.useRef<Swipeable | null>(null);
        const sessionActionTarget = React.useMemo(
            () => createSessionActionTarget({
                session: resolvedSession,
                serverId: serverId ?? null,
                currentUserId: currentUserId ?? null,
                isConnected: sessionStatus.isConnected,
                isPinned: Boolean(pinned),
                attentionStandingEnabled: Boolean(attentionStandingEnabled),
                attentionStanding: Boolean(attentionStanding),
            }),
            [
                attentionStanding,
                attentionStandingEnabled,
                currentUserId,
                pinned,
                resolvedSession,
                serverId,
                sessionStatus.isConnected,
            ],
        );
        const isMinimal = Boolean(compact && compactMinimal);
        const canArchiveSession = sessionActionTarget.canArchive;
        const swipeEnabled = Platform.OS !== 'web' && nativeInlineDragEnabled !== true && canArchiveSession;
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
        const useReadableNativePhoneMinimalRow = shouldUseReadableNativePhoneMinimalSessionRow({
            compact: Boolean(compact),
            compactMinimal: Boolean(compactMinimal),
            isTablet,
            platform: Platform.OS,
        });
        const showRowActions = isWeb && (isRowHovered || isActionsHovered || tagMenuOpen || moreMenuOpen || isBeingDragged === true);
        const rowActionIconColor = theme.colors.text.secondary;
        const resolveSessionDebugInformation = React.useCallback(() => {
            const fullSession = storage.getState().sessions[resolvedSession.id];
            const debugSession = fullSession ?? resolvedSession;
            const debugMetadata = debugSession.metadata ?? resolvedSession.metadata;
            const debugAgentId = resolveAgentIdFromSessionMetadata(debugMetadata)
                ?? resolveAgentIdFromFlavor(debugMetadata?.flavor)
                ?? resolveAgentIdFromSessionMetadata(resolvedSession.metadata)
                ?? resolveAgentIdFromFlavor(resolvedSession.metadata?.flavor)
                ?? DEFAULT_AGENT_ID;
            const debugAgentCore = getAgentCore(debugAgentId);
            const providerSessionId = resolveProviderSessionIdForDebug({
                metadata: debugMetadata,
                vendorResumeIdField: debugAgentCore.resume.vendorResumeIdField,
            });
            return buildSessionDebugInformation({
                session: debugSession,
                providerDisplayName: t(debugAgentCore.displayNameKey),
                providerSessionId,
            });
        }, [resolvedSession]);
        const confirmDeleteDraft = React.useCallback(async () => {
            if (!draft || !onDeleteDraft) return;
            const confirmed = await Modal.confirm(
                t('sessionDrafts.delete.confirmTitle'),
                t('sessionDrafts.delete.confirmDescription'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('common.delete'),
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
        const showForkAction = forkActionContext != null && canForkConversation({
            session: resolvedSession,
            replayEnabled: forkActionContext.replayEnabled,
            agentSwitchingEnabled,
        });
        const openForkFlow = React.useCallback(() => {
            deferOnWeb(() => {
                fireAndForget((async () => {
                    const { openSessionForkStrategyFlow } = await import(
                        '@/components/sessions/fork/openSessionForkStrategyFlow'
                    );
                    const currentSession = storage.getState().sessions[resolvedSession.id] ?? resolvedSession;
                    const reachableMachineTarget = resolveMachineTargetForSessionFromState(
                        storage.getState(),
                        resolvedSession.id,
                    );
                    openSessionForkStrategyFlow({
                        sessionId: resolvedSession.id,
                        forkSupportSource: currentSession,
                        serverId: serverId ?? null,
                        machineId: reachableMachineTarget?.machineId ?? currentSession.metadata?.machineId ?? null,
                        forkPoint: { type: 'latest' },
                        settings: forkActionContext?.settings ?? null,
                        replayEnabled: forkActionContext?.replayEnabled === true,
                        executionRunsEnabled: forkActionContext?.executionRunsEnabled === true,
                        agentSwitchingEnabled,
                        navigateToSession: (childSessionId, options) => {
                            void navigateToSession(childSessionId, {
                                serverId: options?.serverId ?? serverId ?? null,
                            });
                        },
                        navigateToNewSession: (route) => {
                            router.push(route as any);
                        },
                    });
                })(), { tag: 'SessionItem.openSessionForkStrategyFlow' });
            });
        }, [
            agentSwitchingEnabled,
            forkActionContext,
            navigateToSession,
            resolvedSession,
            router,
            serverId,
        ]);
        const leadingMenuItems = React.useMemo(() => {
            const items: DropdownMenuItem[] = [];
            if (draft && onDeleteDraft) {
                items.push({
                    id: SESSION_DELETE_DRAFT_MENU_ITEM_ID,
                    title: t('sessionDrafts.delete.action'),
                    icon: <Icon name="trash" size={16} color={rowActionIconColor} />,
                });
            }
            if (devModeEnabled) {
                items.push(createCopySessionDebugInformationMenuItem({ iconColor: rowActionIconColor }));
            }
            if (showForkAction) {
                items.push({
                    id: 'session.fork',
                    title: t('sessionInfo.forkSession'),
                    subtitle: undefined,
                    icon: <Icon name="git-branch" size={16} color={rowActionIconColor} />,
                });
            }
            return items;
        }, [devModeEnabled, draft, onDeleteDraft, rowActionIconColor, showForkAction]);
        const handleSelectLeadingMenuItem = React.useCallback(async (itemId: string) => {
            if (itemId === SESSION_DELETE_DRAFT_MENU_ITEM_ID) {
                await confirmDeleteDraft();
                return;
            }
            if (itemId === 'session.fork') {
                openForkFlow();
                return;
            }
            if (itemId !== SESSION_COPY_DEBUG_INFORMATION_MENU_ITEM_ID) return;
            const copied = await copySessionDebugInformationToClipboard(resolveSessionDebugInformation());
            if (copied) {
                copyFeedback.markCopied(resolvedSession.id);
            }
        }, [confirmDeleteDraft, copyFeedback, openForkFlow, resolvedSession.id, resolveSessionDebugInformation]);
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
        const activeTags = tags ?? [];
        const knownTags = allKnownTags ?? [];
        const showReorderHandle = Boolean(reorderHandleGesture);
        const contextMenuAnchorRef = React.useRef<View>(null);
        const [uncontrolledContextMenuOpen, setUncontrolledContextMenuOpen] = React.useState(false);
        const contextMenuOpen = nativeContextMenuOpen ?? uncontrolledContextMenuOpen;
        const setContextMenuOpen = onNativeContextMenuOpenChange ?? setUncontrolledContextMenuOpen;
        const suppressNextPressRef = React.useRef(false);
        const contextMenuWasOpenRef = React.useRef(false);
        const clearSuppressionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const contextMenuPressInTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const clearPressSuppressionTimeout = React.useCallback(() => {
            if (clearSuppressionTimeoutRef.current === null) return;
            clearTimeout(clearSuppressionTimeoutRef.current);
            clearSuppressionTimeoutRef.current = null;
        }, []);
        const suppressNextRowPressTemporarily = React.useCallback(() => {
            suppressNextPressRef.current = true;
            clearPressSuppressionTimeout();
            clearSuppressionTimeoutRef.current = setTimeout(() => {
                suppressNextPressRef.current = false;
                clearSuppressionTimeoutRef.current = null;
            }, CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS);
        }, [clearPressSuppressionTimeout]);
        const clearContextMenuPressInTimer = React.useCallback(() => {
            if (contextMenuPressInTimerRef.current === null) return;
            clearTimeout(contextMenuPressInTimerRef.current);
            contextMenuPressInTimerRef.current = null;
        }, []);
        React.useEffect(() => {
            return () => {
                clearContextMenuPressInTimer();
            };
        }, [clearContextMenuPressInTimer]);
        React.useEffect(() => {
            // When a context menu is opened by an external gesture (e.g. session list long-press),
            // Pressable may still fire `onPress` on touch-up. Suppress that navigation *once*,
            // but don't keep suppressing while the menu stays open (that would require extra taps).
            const wasOpen = contextMenuWasOpenRef.current;
            contextMenuWasOpenRef.current = contextMenuOpen;

            if (!contextMenuOpen || wasOpen) {
                return;
            }

            suppressNextRowPressTemporarily();

            return () => {
                clearPressSuppressionTimeout();
            };
        }, [clearPressSuppressionTimeout, contextMenuOpen, suppressNextRowPressTemporarily]);
        const isBeingDraggedRef = React.useRef<boolean>(false);
        React.useEffect(() => {
            isBeingDraggedRef.current = isBeingDragged === true;
        }, [isBeingDragged]);
        const handleRowPointerEnter = React.useCallback(() => {
            setIsRowHovered(true);
        }, []);

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
                    case 'addRange':
                        rowSelection.addRange();
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
            sessionName: sessionNameResolved,
            hideInactiveSessions: Boolean(hideInactiveSessions),
            iconColor: rowActionIconColor,
            activeTags,
            knownTags,
            tagsEnabled: tagsEnabled === true,
            onSetTags,
            onTogglePinned,
            folderMoveMenuItems,
            onMoveToFolder,
            onSelectFolderMoveMenuItem,
            leadingMenuItems,
            onSelectLeadingMenuItem: handleSelectLeadingMenuItem,
            selectionModeAvailable: Boolean(resolvedSelectionKey),
            selectionModeActive: rowSelection.isSelectionMode,
            onEnterSelectionMode: handleEnterSelectionMode,
            isNativeMobile,
            setContextMenuOpen,
            openTagsMenuFromContext: () => {
                setTagMenuEverOpened(true);
                setTagMenuOpen(true);
            },
            deferredContextActionDelayMs: CONTEXT_MENU_DEFERRED_ACTION_DELAY_MS,
        });

        const handleSwipeAction = React.useCallback(async () => {
            swipeableRef.current?.close();
            await handleMoreMenuSelect(SESSION_ACTION_ARCHIVE_ID);
        }, [handleMoreMenuSelect]);

        const accessibilityActions = React.useMemo(() => {
            const actions: Array<{ name: string; label: string }> = [];
            if (onMoveUp) actions.push({ name: 'moveUp', label: t('common.moveUp') });
            if (onMoveDown) actions.push({ name: 'moveDown', label: t('common.moveDown') });
            if (onMoveToFolder) actions.push({ name: 'moveToFolder', label: t('sessionsList.moveToFolder') });
            if (onMoveToWorkspaceRoot) actions.push({ name: 'moveToWorkspaceRoot', label: t('sessionsList.moveToWorkspaceRoot') });
            if (draft && onDeleteDraft) actions.push({ name: 'deleteDraft', label: t('sessionDrafts.delete.action') });
            return actions;
        }, [draft, onDeleteDraft, onMoveDown, onMoveToFolder, onMoveToWorkspaceRoot, onMoveUp]);

        const handleAccessibilityAction = React.useCallback((event: { nativeEvent?: { actionName?: string } }) => {
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
            }
        }, [confirmDeleteDraft, onMoveDown, onMoveToFolder, onMoveToWorkspaceRoot, onMoveUp]);

        const avatarId = React.useMemo(() => {
            return getSessionAvatarId(resolvedSession);
        }, [resolvedSession]);
        const pendingBadge = formatPendingCountBadge(pendingCount);
        const tagChipDensity: 'default' | 'compact' | 'minimal' = isMinimal ? 'minimal' : compact ? 'compact' : 'default';
        const sourceTagChips = React.useMemo(() => {
            if (!tagsEnabled || activeTags.length === 0) return [];
            return activeTags.map((tag, index) => ({ key: `${tag}:${index}`, label: tag }));
        }, [activeTags, tagsEnabled]);
        const fallbackSecondaryLineMode: SessionListSecondaryLineMode = variant === 'no-path' ? 'status' : 'path';
        const requestedSecondaryLineMode = secondaryLineMode ?? fallbackSecondaryLineMode;
        const effectiveSubtitleEllipsizeMode = subtitleEllipsizeMode ?? 'head';
        const rowDensity = isMinimal ? 'minimal' : compact ? 'compact' : 'default';
        const effectiveSecondaryLineMode = rowPresentation.secondaryLine === 'path' ? 'path' : 'status';
        const statusLineText = rowPresentation.statusTextKey ? t(rowPresentation.statusTextKey) : sessionStatus.statusText;
        const rowStatusColor = rowPresentation.backgroundActivityStatusLine === true
            ? theme.colors.text.secondary
            : resolveSessionRowAttentionStateColor(rowAttentionState, theme);
        const rowAttentionAccessibilityLabel =
            rowAttentionState === 'failed'
                ? t('status.error')
                : rowPresentation.attentionIndicator === 'working'
                || rowPresentation.attentionIndicator === 'permission'
                || rowPresentation.attentionIndicator === 'action'
                ? statusLineText
                : rowPresentation.statusTextKey
                    ? statusLineText
                    : undefined;
        const shouldShowStatusSecondaryLine = rowPresentation.secondaryLine === 'status' && statusLineText.trim().length > 0;
        const shouldShowPathSecondaryLine = rowPresentation.secondaryLine === 'path' && Boolean(sessionSubtitle);
        const shouldUsePathSubtitleStartEllipsis = shouldShowPathSecondaryLine && effectiveSubtitleEllipsizeMode === 'head';
        const shouldUseWebPathSubtitleStartEllipsis = shouldUsePathSubtitleStartEllipsis && isWeb;
        const shouldShowIdentitySubtitleSkeleton = !isMinimal && isSessionIdentityLoading && requestedSecondaryLineMode === 'path';
        const showStandardSecondaryLine = !isMinimal && (
            shouldShowIdentitySubtitleSkeleton
            || shouldShowStatusSecondaryLine
            || shouldShowPathSecondaryLine
        );
        const shouldEmphasizeTitle = rowPresentation.titleTone === 'emphasized';
        const shouldMuteTitle = rowPresentation.titleTone === 'quiet';
        const trailingAttentionIndicator = isMinimal ? rowPresentation.attentionIndicator : 'none';
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
                density: rowDensity,
                tags: sourceTagChips,
                rowWidth,
                hasTrailingMeta,
                hasRowActions: showRowActions,
                hasLeadingIdentity: shouldRenderSessionListIdentity || shouldRenderSelectionCheckbox,
            })
        ), [hasTrailingMeta, rowDensity, rowWidth, shouldRenderSelectionCheckbox, shouldRenderSessionListIdentity, showRowActions, sourceTagChips]);
        const tagChips = tagDisplayPlan.chips;
        const showTagChips = tagChips.length > 0;
        const showInlineTagChips = showTagChips && tagDisplayPlan.placement === 'inline';
        const showBelowTagChips = showTagChips && tagDisplayPlan.placement === 'below';
        const enableLongPressContextMenu =
            Platform.OS === 'ios'
            && nativeInlineDragEnabled !== true
            && contextMenuItems.length > 0;
        const openContextMenuFromLongPress = React.useCallback(() => {
            clearContextMenuPressInTimer();
            if (!enableLongPressContextMenu || isBeingDraggedRef.current) return;
            suppressNextPressRef.current = true;
            setContextMenuOpen(true);
        }, [clearContextMenuPressInTimer, enableLongPressContextMenu, setContextMenuOpen]);

        const shouldRenderAvatarMonochrome = resolvedSession.active !== true || !sessionStatus.isConnected;
        const identityMetrics = resolveSessionListRowIdentityMetrics({
            density: isMinimal ? 'minimal' : compact ? 'compact' : 'default',
            readableNativePhoneMinimal: useReadableNativePhoneMinimalRow,
        });
        const avatarSize = identityMetrics.slotSize;
        const agentLogoSize = identityMetrics.agentLogoSize;
        const agentLogoId = resolveAgentIdFromFlavor(resolvedSession.metadata?.flavor) ?? DEFAULT_AGENT_ID;
        const normalizedFolderDepth = typeof folderDepth === 'number' && Number.isFinite(folderDepth)
            ? Math.max(0, Math.min(SESSION_FOLDER_ROW_INDENT_CAP, Math.trunc(folderDepth)))
            : 0;
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
            titleTone: rowPresentation.titleTone,
        });
        const sessionTitleColor = sessionTitleColorRole === 'primary'
            ? theme.colors.text.primary
            : theme.colors.text.secondary;
        const sessionTitleStyle = [
            styles.sessionTitle,
            compact ? styles.sessionTitleCompact : null,
            isMinimal ? styles.sessionTitleMinimal : null,
            useReadableNativePhoneMinimalRow ? styles.sessionTitleMinimalNativePhone : null,
            shouldEmphasizeTitle ? styles.sessionTitleEmphasized : null,
            shouldMuteTitle ? null : sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
            selected || rowSelection.isSelected ? styles.sessionTitleSelected : null,
            { color: sessionTitleColor },
        ];
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
            <Pressable
                testID={`session-list-item-${resolvedSession.id}`}
                accessibilityActions={accessibilityActions}
                accessibilityState={{ selected: Boolean(selected || rowSelection.isSelected) }}
                onAccessibilityAction={accessibilityActions.length > 0 ? handleAccessibilityAction : undefined}
                onLayout={sourceTagChips.length > 0 ? handleRowLayout : undefined}
                style={[
                    styles.sessionItem,
                    isFirst ? styles.sessionItemFirst : null,
                    isLast ? styles.sessionItemLast : null,
                    compact ? styles.sessionItemCompact : null,
                    isMinimal ? styles.sessionItemMinimal : null,
                    useReadableNativePhoneMinimalRow ? styles.sessionItemMinimalNativePhone : null,
                    selected || rowSelection.isSelected ? styles.sessionItemSelected : null,
                    embedded && !embeddedIsLast ? styles.embeddedSeparator : null,
                ]}
                onPress={handleRowPress}
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
                {shouldRenderSessionListIdentity || shouldRenderSelectionCheckbox ? (
                    <View
                        style={[
                            styles.avatarContainer,
                            compact ? styles.avatarContainerCompact : null,
                            isMinimal ? styles.avatarContainerMinimal : null,
                            useReadableNativePhoneMinimalRow ? styles.avatarContainerMinimalNativePhone : null,
                        ]}
                    >
                        {shouldRenderSelectionCheckbox ? (
                            <SessionListSelectionCheckbox
                                sessionId={resolvedSession.id}
                                selectionKey={resolvedSelectionKey}
                                selected={rowSelection.isSelected}
                                onPress={rowSelection.toggle}
                                style={[
                                    compact ? styles.avatarContainerCompact : null,
                                    isMinimal ? styles.avatarContainerMinimal : null,
                                    useReadableNativePhoneMinimalRow ? styles.avatarContainerMinimalNativePhone : null,
                                ]}
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
                        ) : shouldRenderSessionListAvatar ? (
                            <Avatar
                                id={avatarId}
                                size={avatarSize}
                                monochrome={shouldRenderAvatarMonochrome}
                                flavor={resolvedSession.metadata?.flavor}
                                hasUnreadMessages={false}
                            />
                        ) : (
                            <AgentIcon
                                agentId={agentLogoId}
                                size={agentLogoSize}
                                color={sessionTitleColor}
                                style={{ transform: [{ scale: getAgentPickerIconScale(agentLogoId) }] }}
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
                    </View>
                ) : null}
                <View
                    style={[
                        styles.sessionContent,
                        compact ? styles.sessionContentCompact : null,
                        isMinimal ? styles.sessionContentMinimal : null,
                        isMinimal && (shouldRenderSessionListIdentity || shouldRenderSelectionCheckbox) ? styles.sessionContentMinimalWithIdentity : null,
                    ]}
                >
                    <View style={styles.sessionTitleRow}>
                        {isSessionIdentityLoading ? (
                            <Animated.View
                                testID={`session-list-title-loading-${resolvedSession.id}`}
                                style={[
                                    identityTitleLoadingStyle,
                                    { opacity: identitySkeletonOpacity },
                                ]}
                            />
                        ) : (
                            <Text
                                style={sessionTitleStyle}
                                numberOfLines={1}
                            >
                                {sessionNameResolved}
                            </Text>
                        )}
                        {showServerBadge && serverName ? (
                            <View style={styles.serverBadgeContainer}>
                                <Text style={styles.serverBadgeText} numberOfLines={1}>
                                    {serverName}
                                </Text>
                            </View>
                        ) : null}
                        {draft ? (
                            <View
                                testID={`session-list-draft-indicator:${resolvedSession.id}`}
                                accessible={true}
                                accessibilityRole="text"
                                accessibilityLabel={draft.preview ? `${t('sessionDrafts.badge')}, ${draft.preview}` : t('sessionDrafts.badge')}
                                accessibilityHint={t('sessionDrafts.continueEditing')}
                                style={[
                                    styles.draftBadge,
                                    compact ? styles.draftBadgeCompact : null,
                                    isMinimal ? styles.draftBadgeMinimal : null,
                                ]}
                            >
                                <Icon name="pencil-simple" size={compact ? 10 : 11} color={theme.colors.text.secondary} />
                                {!isMinimal ? (
                                    <Text style={styles.draftBadgeText} numberOfLines={1}>
                                        {t('sessionDrafts.badge')}
                                    </Text>
                                ) : null}
                            </View>
                        ) : null}
                    </View>

                    {draft && !compact && draft.preview ? (
                        <Text
                            testID={`session-list-draft-preview:${resolvedSession.id}`}
                            style={styles.draftPreviewText}
                            numberOfLines={1}
                        >
                            {`${t('sessionDrafts.badge')} · ${draft.preview}`}
                        </Text>
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
                                <View
                                    style={[
                                        styles.secondaryStatusDotContainer,
                                        compact ? styles.secondaryStatusDotContainerCompact : null,
                                    ]}
                                >
                                    {rowPresentation.attentionIndicator !== 'none' ? (
                                        <SessionRowAttentionIndicator
                                            indicator={rowPresentation.attentionIndicator}
                                            sessionId={`${resolvedSession.id}-secondary`}
                                            attentionState={rowAttentionState}
                                            accessibilityLabel={rowAttentionAccessibilityLabel}
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
                                        { color: rowStatusColor },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {statusLineText}
                                </Text>
                                {agentActivityLabel !== null ? (
                                    <Text
                                        testID={`session-list-agent-activity-count-${resolvedSession.id}`}
                                        style={[
                                            styles.statusText,
                                            compact ? styles.statusTextCompact : null,
                                            styles.agentActivityCountText,
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {agentActivityLabel}
                                    </Text>
                                ) : null}
                            </View>
                        ) : (
                            <Text
                                style={[
                                    styles.sessionSubtitle,
                                    compact ? styles.sessionSubtitleCompact : null,
                                    shouldUseWebPathSubtitleStartEllipsis ? styles.sessionPathSubtitleWeb : null,
                                ]}
                                numberOfLines={1}
                                ellipsizeMode={shouldUseWebPathSubtitleStartEllipsis ? undefined : effectiveSubtitleEllipsizeMode}
                            >
                                {shouldUseWebPathSubtitleStartEllipsis ? (
                                    <Text style={styles.sessionPathSubtitleTextWeb}>
                                        {sessionSubtitle}
                                    </Text>
                                ) : sessionSubtitle}
                            </Text>
                        )
                    ) : null}

                    {showBelowTagChips ? renderTagChipRow('below') : null}
                </View>
                <View
                    testID="session-item-right-area"
                    style={styles.rightArea}
                    onPointerEnter={isWeb ? handleActionsHoverIn : undefined}
                    onPointerLeave={isWeb ? handleActionsHoverOut : undefined}
                >
                    {showInlineTagChips ? renderTagChipRow('inline') : null}
                    <CopiedPill
                        visible={copyFeedback.isCopied(resolvedSession.id)}
                        testID={`session-item-copy-debug-feedback:${resolvedSession.id}`}
                    />
                    {showRowActions ? (
                        <View style={styles.rowActionsRow}>
                            {showReorderHandle && reorderHandleGesture ? (
                                <GestureDetector gesture={reorderHandleGesture}>
                                    <View
                                        testID="session-item-reorder-handle"
                                        style={styles.rowActionButton}
                                        onPointerDown={isWeb ? suppressNextRowPressTemporarily : undefined}
                                        onPointerUp={isWeb ? suppressNextRowPressTemporarily : undefined}
                                        onPointerCancel={isWeb ? suppressNextRowPressTemporarily : undefined}
                                    >
                                        <Icon name="list" size={16} color={rowActionIconColor} />
                                    </View>
                                </GestureDetector>
                            ) : null}
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
                                        placement="left"
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
                                    placement="left"
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
                    ) : showTrailingAttentionIndicator || showTrailingActivityTime ? (
                        <View style={styles.trailingMetaRow}>
                            {showTrailingAttentionIndicator ? (
                                <SessionRowAttentionIndicator
                                    indicator={trailingAttentionIndicator}
                                    sessionId={`${resolvedSession.id}-trailing`}
                                    attentionState={rowAttentionState}
                                    accessibilityLabel={rowAttentionAccessibilityLabel}
                                    workingMode={workingIndicatorMode}
                                    workingSpinnerTone="neutral"
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
                </View>
            </Pressable>
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

        const shouldRenderNativeContextMenu = isNativeMobile && contextMenuOpen && contextMenuItems.length > 0;
        const shouldRenderNativeTagMenu = isNativeMobile && supportsTag && tagMenuOpen;
        const menuNodes = shouldRenderNativeContextMenu || shouldRenderNativeTagMenu ? (
            <>
                {shouldRenderNativeContextMenu ? (
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
                {shouldRenderNativeTagMenu ? (
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
            </View>
        );
    },
);

function SessionItemFromRowModel(props: SessionItemProps & { rowModel: SessionListRowModel }) {
    const { rowModel, ...itemProps } = props;
    const session = rowModel.session;
    return (
        <SessionItemContent
            {...itemProps}
            session={session}
            selectionKey={itemProps.selectionKey ?? rowModel.rowKey}
            subtitleEllipsizeMode={itemProps.subtitleEllipsizeMode ?? rowModel.subtitleEllipsizeMode}
            serverId={rowModel.serverId ?? undefined}
            serverName={itemProps.serverName ?? rowModel.serverName}
            currentUserId={itemProps.currentUserId ?? rowModel.currentUserId}
            showServerBadge={itemProps.showServerBadge ?? rowModel.showServerBadge}
            pinned={itemProps.pinned ?? rowModel.isPinned}
            attentionStandingEnabled={itemProps.attentionStandingEnabled ?? rowModel.attentionStandingEnabled}
            attentionStanding={itemProps.attentionStanding ?? rowModel.isAttentionStanding}
            tags={itemProps.tags ?? [...rowModel.tags]}
            allKnownTags={itemProps.allKnownTags ?? [...rowModel.allKnownTags]}
            tagsEnabled={itemProps.tagsEnabled ?? rowModel.tagsEnabled}
            selected={itemProps.selected ?? rowModel.isSelected}
            isFirst={itemProps.isFirst ?? rowModel.adjacency.isFirst}
            isLast={itemProps.isLast ?? rowModel.adjacency.isLast}
            isSingle={itemProps.isSingle ?? rowModel.adjacency.isSingle}
            variant={itemProps.variant ?? rowModel.variant ?? 'default'}
            secondaryLineMode={itemProps.secondaryLineMode ?? rowModel.secondaryLineMode}
            compact={itemProps.compact ?? rowModel.compact}
            compactMinimal={itemProps.compactMinimal ?? rowModel.compactMinimal}
            folderDepth={itemProps.folderDepth ?? rowModel.folder.depth}
            sessionStatus={rowModel.status}
            sessionNameResolved={rowModel.title}
            sessionSubtitle={itemProps.subtitleOverride ?? rowModel.subtitle}
            pendingCount={rowModel.pendingCount}
            draft={rowModel.draft}
            agentActivityLabel={rowModel.agentActivityLabel}
            isSessionIdentityLoading={rowModel.isIdentityLoading}
            activityTimeLabel={rowModel.activity.label}
            rowAttentionState={rowModel.attention.rowState}
            rowPresentation={rowModel.presentation}
            workingIndicatorMode={rowModel.workingIndicatorMode}
            workingIndicatorPaused={rowModel.workingIndicatorPaused}
            rowAttentionAnimationEnabled={itemProps.rowAttentionAnimationEnabled !== false}
            sessionListIdentityDisplay={normalizeSessionItemIdentityDisplay(rowModel.identityDisplay)}
            sessionListActiveColorMode={normalizeSessionItemActiveColorMode(rowModel.activeColorMode)}
            hideInactiveSessions={itemProps.hideInactiveSessions ?? rowModel.hideInactiveSessions}
        />
    );
}

export const SessionItem = React.memo(function SessionItem(props: SessionItemProps) {
    const { rowModel } = props;
    if (!rowModel) {
        throw new Error('SessionItem requires a row model. Build row models in the session-list owner before rendering rows.');
    }
    return <SessionItemFromRowModel {...props} rowModel={rowModel} />;
});
