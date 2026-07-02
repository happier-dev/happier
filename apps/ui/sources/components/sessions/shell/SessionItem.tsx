import React from 'react';
import { Animated, Platform, Pressable, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, Swipeable, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, Text as RNText } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { Typography } from '@/constants/Typography';
import { formatPendingCountBadge } from '@/components/sessions/pendingBadge';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { t } from '@/text';
import {
    deriveSessionListAttentionState,
    type SessionListSecondaryLineMode,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionAvatarId, getSessionName, getSessionSubtitle, type SessionStatus } from '@/utils/sessions/sessionUtils';
import { PinIcon, PinSlashIcon } from './sessionPinIcons';
import { TagIcon } from './sessionTagIcons';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import {
    resolveSessionRowAttentionState,
    resolveSessionRowPresentation,
} from './row/resolveSessionRowPresentation';
import {
    normalizeSessionListActiveColorMode,
    resolveSessionRowTitleColorRole,
} from './row/sessionRowTitleColorRole';
import { SessionRowAttentionIndicator } from './row/SessionRowAttentionIndicator';
import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
} from './sessionListRowHeights';
import { resolveSessionRowInteractionPolicy } from './row/resolveSessionRowInteractionPolicy';
import { resolveSessionItemTagCollections } from './sessionTagUtils';
import { planSessionTagDisplay } from './sessionTagPlacement';
import { useSessionSplitCanvasRowActionsForScope } from '@/components/sessions/canvas/useSessionSplitCanvasRowActions';
import { SessionSplitCanvasDragHandle } from '@/components/sessions/canvas/SessionSplitCanvasDragHandle';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { resolveSessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';
import { useIsTablet } from '@/utils/platform/responsive';
import type { SessionListRowViewModel } from './sessionListRowViewModels';
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
import { useSessionRowActionMenu } from './row/actionMenu/useSessionRowActionMenu';
import {
    SESSION_ROW_ACTION_OPEN_SPLIT_DOWN_ID,
    SESSION_ROW_ACTION_OPEN_SPLIT_RIGHT_ID,
    SESSION_ROW_ACTION_REVEAL_IN_CURRENT_SPLIT_ID,
} from './row/actionMenu/sessionRowActionMenuTypes';

const AVATAR_SIZE_DEFAULT = 48;
const AVATAR_SIZE_COMPACT = 30;
const AVATAR_SIZE_MINIMAL = 18;
const AVATAR_SIZE_MINIMAL_NATIVE_PHONE = 20;
const SESSION_LIST_MINIMAL_IDENTITY_GAP = 8;
const SESSION_LIST_AGENT_LOGO_SIZE_RATIO = 0.78;
const SESSION_LIST_AGENT_LOGO_MIN_SIZE = 14;
const CONTEXT_MENU_DEFERRED_ACTION_DELAY_MS = 0;
const CONTEXT_MENU_PRESS_IN_OPEN_DELAY_MS = 350;
const CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS = 600;
const SESSION_IDENTITY_SKELETON_ANIMATION_MS = 900;
const SESSION_FOLDER_ROW_CHROME_INDENT_BASE = 38;
const SESSION_FOLDER_ROW_CHROME_INDENT_STEP = 12;
const SESSION_FOLDER_MOVE_MENU_INDENT_BASE = 16;
const SESSION_FOLDER_MOVE_MENU_INDENT_STEP = 12;

type SessionItemWorkingIndicatorMode = 'spinner' | 'pulse';
type SessionItemIdentityDisplay = 'avatar' | 'agentLogo' | 'none';
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
    folderMoveTargets?: readonly SessionFolderMoveTarget[];
    onMoveToSessionFolder?: (folderId: string | null) => void | Promise<void>;
    onMoveToFolder?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    reorderHandleGesture?: GestureType | ComposedGesture;
    isBeingDragged?: boolean;
    nativeInlineDragEnabled?: boolean;
    nativeContextMenuOpen?: boolean;
    onNativeContextMenuOpenChange?: (next: boolean) => void;
    rowAttentionAnimationEnabled?: boolean;
}>;

export type SessionItemProps = SessionItemBaseProps & Readonly<{
    rowViewModel: SessionListRowViewModel;
    hideInactiveSessions?: boolean;
}>;

type SessionItemContentProps = Omit<SessionItemBaseProps, 'subtitleOverride'> & Readonly<{
    sessionStatus: SessionStatus;
    sessionNameResolved: string;
    sessionSubtitle: string;
    isSessionIdentityLoading: boolean;
    activityTimeLabel: string;
    hasUnreadMessages: boolean;
    workingIndicatorMode: SessionItemWorkingIndicatorMode;
    rowAttentionAnimationEnabled: boolean;
    sessionListIdentityDisplay: SessionItemIdentityDisplay;
    sessionListActiveColorMode: SessionItemActiveColorMode;
    hideInactiveSessions: boolean;
}>;

function resolveSessionListAgentLogoSize(slotSize: number): number {
    return Math.max(SESSION_LIST_AGENT_LOGO_MIN_SIZE, Math.round(slotSize * SESSION_LIST_AGENT_LOGO_SIZE_RATIO));
}

function normalizeSessionItemIdentityDisplay(value: unknown): SessionItemIdentityDisplay {
    return value === 'agentLogo' || value === 'none' ? value : 'avatar';
}

function normalizeSessionItemActiveColorMode(value: unknown): SessionItemActiveColorMode {
    return value === 'attentionOnly' || value === 'allActive' ? value : 'activityAndAttention';
}

function hasPendingUserActionRequests(session: Session | SessionListRenderableSession): boolean {
    return 'hasPendingUserActionRequests' in session && session.hasPendingUserActionRequests === true;
}

function hasPendingPermissionRequests(session: Session | SessionListRenderableSession): boolean {
    return 'hasPendingPermissionRequests' in session && session.hasPendingPermissionRequests === true;
}

function resolveSessionItemEffectiveStatus(input: Readonly<{
    rowSession: SessionListRenderableSession;
    renderedSession: Session | SessionListRenderableSession;
    rowStatus: SessionStatus;
}>): SessionStatus {
    if (input.renderedSession === input.rowSession) {
        return input.rowStatus;
    }

    if (
        hasPendingUserActionRequests(input.renderedSession)
        && !hasPendingUserActionRequests(input.rowSession)
    ) {
        return {
            ...input.rowStatus,
            state: 'action_required',
            statusText: t('status.actionRequired'),
            shouldShowStatus: true,
            isPulsing: true,
        };
    }

    if (
        hasPendingPermissionRequests(input.renderedSession)
        && !hasPendingPermissionRequests(input.rowSession)
    ) {
        return {
            ...input.rowStatus,
            state: 'permission_required',
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
            isPulsing: true,
        };
    }

    return input.rowStatus;
}

function resolveSessionItemEffectiveSession(input: Readonly<{
    rowSession: SessionListRenderableSession;
    providedSession: Session | SessionListRenderableSession;
}>): Session | SessionListRenderableSession {
    if (input.providedSession.id !== input.rowSession.id) {
        return input.rowSession;
    }
    if (
        hasPendingUserActionRequests(input.providedSession)
        && !hasPendingUserActionRequests(input.rowSession)
    ) {
        return input.providedSession;
    }
    if (
        hasPendingPermissionRequests(input.providedSession)
        && !hasPendingPermissionRequests(input.rowSession)
    ) {
        return input.providedSession;
    }
    return input.rowSession;
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
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionItemContainerSingle: {
        borderRadius: 12,
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
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        borderTopWidth: 2,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
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
        paddingHorizontal: 10,
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
        width: AVATAR_SIZE_DEFAULT,
        height: AVATAR_SIZE_DEFAULT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarContainerCompact: {
        width: AVATAR_SIZE_COMPACT,
        height: AVATAR_SIZE_COMPACT,
    },
    avatarContainerMinimal: {
        width: AVATAR_SIZE_MINIMAL,
        height: AVATAR_SIZE_MINIMAL,
    },
    avatarContainerMinimalNativePhone: {
        width: AVATAR_SIZE_MINIMAL_NATIVE_PHONE,
        height: AVATAR_SIZE_MINIMAL_NATIVE_PHONE,
    },
    avatarLoading: {
        width: AVATAR_SIZE_DEFAULT,
        height: AVATAR_SIZE_DEFAULT,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
    },
    avatarLoadingCompact: {
        width: AVATAR_SIZE_COMPACT,
        height: AVATAR_SIZE_COMPACT,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
    },
    avatarLoadingMinimal: {
        width: AVATAR_SIZE_MINIMAL,
        height: AVATAR_SIZE_MINIMAL,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.elevated,
    },
    avatarLoadingMinimalNativePhone: {
        width: AVATAR_SIZE_MINIMAL_NATIVE_PHONE,
        height: AVATAR_SIZE_MINIMAL_NATIVE_PHONE,
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
    draftIconOverlay: {
        color: theme.colors.text.secondary,
    },
    draftIconContainerCompact: {
        width: 16,
        height: 16,
        bottom: -1,
        right: -1,
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
        fontSize: 14,
        flex: 1,
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    sessionTitleCompact: {
        fontSize: 14,
    },
    sessionTitleMinimal: {
        fontSize: 14,
        lineHeight: 18,
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
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default(),
    },
    statusTextCompact: {
        fontSize: 11,
        lineHeight: 11,
    },
    statusTextMinimal: {
        fontSize: 10,
        lineHeight: 12,
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
    swipeActionIcon: {
        color: theme.colors.button.primary.tint,
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
        folderMoveTargets,
        onMoveToSessionFolder,
        onMoveToFolder,
        onMoveToWorkspaceRoot,
        onMoveUp,
        onMoveDown,
        reorderHandleGesture,
        isBeingDragged,
        nativeInlineDragEnabled,
        nativeContextMenuOpen,
        onNativeContextMenuOpenChange,
        sessionStatus,
        sessionNameResolved,
        sessionSubtitle,
        isSessionIdentityLoading,
        activityTimeLabel,
        hasUnreadMessages,
        workingIndicatorMode,
        rowAttentionAnimationEnabled,
        sessionListIdentityDisplay,
        sessionListActiveColorMode,
        hideInactiveSessions,
    }: SessionItemContentProps) => {
        const styles = stylesheet;
        const { theme } = useUnistyles();
        const resolvedSession = session;
        const sessionId = String(resolvedSession?.id ?? '').trim();
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
        const sessionActionTarget = React.useMemo(() => createSessionActionTarget({
            session: resolvedSession,
            serverId: serverId ?? null,
            currentUserId: currentUserId ?? null,
            isConnected: sessionStatus.isConnected,
            isPinned: Boolean(pinned),
        }), [currentUserId, pinned, resolvedSession, serverId, sessionStatus.isConnected]);
        const isActiveSession = sessionActionTarget.isActive;
        const isMinimal = Boolean(compact && compactMinimal);
        const canStopSession = sessionActionTarget.canStop;
        const canArchiveSession = sessionActionTarget.canArchive;
        const [isRowHovered, setIsRowHovered] = React.useState(false);
        const [isActionsHovered, setIsActionsHovered] = React.useState(false);
        const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
        const [tagMenuEverOpened, setTagMenuEverOpened] = React.useState(false);
        const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
        const [rowWidth, setRowWidth] = React.useState<number | null>(null);
        const isWeb = Platform.OS === 'web';
        const isNativeMobile = Platform.OS === 'ios' || Platform.OS === 'android';
        const isTablet = useIsTablet();
        const useReadableNativePhoneMinimalRow = isMinimal && isNativeMobile && !isTablet;
        const showRowActions = isWeb && (isRowHovered || isActionsHovered || tagMenuOpen || moreMenuOpen || isBeingDragged === true);
        const rowActionIconColor = theme.colors.text.secondary;
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
        const showSplitCanvasDragHandle = splitCanvasRowActions.mode === 'open' && showRowActions;
        const { activeTags, knownTags } = React.useMemo(() => resolveSessionItemTagCollections({
            tags,
            allKnownTags,
        }), [allKnownTags, tags]);
        const contextMenuAnchorRef = React.useRef<View>(null);
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
            if (Platform.OS === 'web' && reorderHandleGesture && (isReorderDragActive || wasBeingDragged)) {
                suppressNextPressForPointerGesture();
            }
        }, [isBeingDragged, reorderHandleGesture, suppressNextPressForPointerGesture]);
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

        const folderMoveMenuItems = React.useMemo((): DropdownMenuItem[] => (
            (folderMoveTargets ?? []).map((target): DropdownMenuItem => ({
                id: target.id,
                testID: resolveSessionFolderMoveTargetTestId(target),
                title: target.title,
                icon: target.folderId
                    ? <Ionicons name="folder-outline" size={16} color={rowActionIconColor} />
                    : <Ionicons name="file-tray-outline" size={16} color={rowActionIconColor} />,
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
                        icon: <Ionicons name="arrow-forward-outline" size={16} color={rowActionIconColor} />,
                    },
                    {
                        id: SESSION_ROW_ACTION_OPEN_SPLIT_DOWN_ID,
                        title: t('sessionInfo.openInSplitDown'),
                        icon: <Ionicons name="arrow-down-outline" size={16} color={rowActionIconColor} />,
                    },
                ];
            }
            if (splitCanvasRowActions.mode === 'reveal') {
                return [{
                    id: SESSION_ROW_ACTION_REVEAL_IN_CURRENT_SPLIT_ID,
                    title: t('sessionInfo.revealInCurrentSplit'),
                    icon: <Ionicons name="locate-outline" size={16} color={rowActionIconColor} />,
                }];
            }
            return [];
        }, [rowActionIconColor, splitCanvasRowActions.mode]);

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
            leadingMenuItems: splitCanvasMenuItems,
            onSelectLeadingMenuItem: handleSelectSplitCanvasMenuItem,
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
            deferredContextActionDelayMs: CONTEXT_MENU_DEFERRED_ACTION_DELAY_MS,
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
            return actions;
        }, [onMoveDown, onMoveToFolder, onMoveToWorkspaceRoot, onMoveUp]);

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
                default:
                    break;
            }
        }, [onMoveDown, onMoveToFolder, onMoveToWorkspaceRoot, onMoveUp]);

        const {
            swipeEnabled,
            showReorderHandle,
            enableLongPressContextMenu,
            suppressNextPressOnNativeContextMenuOpen,
        } = React.useMemo(() => resolveSessionRowInteractionPolicy({
            platformOs: Platform.OS,
            isActiveSession,
            canStopSession,
            canArchiveSession,
            contextMenuItemCount: contextMenuItems.length,
            contextMenuOpen,
            contextMenuWasOpen: contextMenuWasOpenRef.current,
            nativeInlineDragEnabled: nativeInlineDragEnabled === true,
            hasReorderHandle: Boolean(reorderHandleGesture),
        }), [
            canArchiveSession,
            canStopSession,
            contextMenuItems.length,
            contextMenuOpen,
            isActiveSession,
            nativeInlineDragEnabled,
            reorderHandleGesture,
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

        const avatarId = getSessionAvatarId(resolvedSession);
        const pendingCount = resolvedSession.pendingCount ?? 0;
        const pendingBadge = formatPendingCountBadge(pendingCount);
        const tagChipDensity: 'default' | 'compact' | 'minimal' = isMinimal ? 'minimal' : compact ? 'compact' : 'default';
        const sourceTagChips = React.useMemo(() => {
            if (!tagsEnabled || activeTags.length === 0) return [];
            return activeTags.map((tag, index) => ({ key: `${tag}:${index}`, label: tag }));
        }, [activeTags, tagsEnabled]);
        const fallbackSecondaryLineMode: SessionListSecondaryLineMode = variant === 'no-path' ? 'status' : 'path';
        const requestedSecondaryLineMode = secondaryLineMode ?? fallbackSecondaryLineMode;
        const rowDensity = isMinimal ? 'minimal' : compact ? 'compact' : 'default';
        const rowAttentionState = resolveSessionRowAttentionState(deriveSessionListAttentionState({
            hasUnreadMessages,
            pendingCount,
            sessionState: sessionStatus.state,
            latestTurnStatus: resolvedSession.latestTurnStatus ?? null,
            lastRuntimeIssue: resolvedSession.lastRuntimeIssue ?? null,
            active: resolvedSession.active,
            activeAt: resolvedSession.activeAt,
            presence: resolvedSession.presence,
            thinking: resolvedSession.thinking,
            thinkingAt: resolvedSession.thinkingAt,
            seq: resolvedSession.seq,
            meaningfulActivityAt: resolvedSession.meaningfulActivityAt ?? null,
            latestTurnStatusObservedAt: resolvedSession.latestTurnStatusObservedAt ?? null,
            latestReadyEventSeq: resolvedSession.latestReadyEventSeq ?? null,
            lastViewedSessionSeq: resolvedSession.lastViewedSessionSeq ?? null,
            pendingRequestObservedAt: resolvedSession.pendingRequestObservedAt ?? null,
        }));
        const rowPresentation = resolveSessionRowPresentation({
            attentionState: rowAttentionState,
            density: rowDensity,
            requestedSecondaryLineMode,
            hasPathSubtitle: Boolean(sessionSubtitle),
        });
        const effectiveSecondaryLineMode: SessionListSecondaryLineMode = rowPresentation.secondaryLine === 'path' ? 'path' : 'status';
        const statusLineText = rowPresentation.statusTextKey ? t(rowPresentation.statusTextKey) : sessionStatus.statusText;
        const rowStatusColor = (() => {
            switch (rowAttentionState) {
                case 'working':
                    return theme.colors.state.info.foreground;
                case 'ready':
                    return theme.colors.state.success.foreground;
                case 'failed':
                    return theme.colors.state.danger.foreground;
                case 'permission_required':
                case 'action_required':
                    return theme.colors.state.warning.foreground;
                case 'unread':
                    return theme.colors.text.link;
                case 'pending':
                    return theme.colors.state.neutral.foreground;
                case 'quiet':
                    return theme.colors.text.secondary;
            }
        })();
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
        const effectiveSubtitleEllipsizeMode = subtitleEllipsizeMode ?? 'head';
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
        const avatarSize = isMinimal
            ? useReadableNativePhoneMinimalRow
                ? AVATAR_SIZE_MINIMAL_NATIVE_PHONE
                : AVATAR_SIZE_MINIMAL
            : compact
                ? AVATAR_SIZE_COMPACT
                : AVATAR_SIZE_DEFAULT;
        const agentLogoSize = resolveSessionListAgentLogoSize(avatarSize);
        const agentLogoId = resolveAgentIdFromFlavor(resolvedSession.metadata?.flavor) ?? DEFAULT_AGENT_ID;

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
        const sessionTitleStyle = [
            styles.sessionTitle,
            compact ? styles.sessionTitleCompact : null,
            isMinimal ? styles.sessionTitleMinimal : null,
            shouldEmphasizeTitle ? styles.sessionTitleEmphasized : null,
            sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
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
                accessibilityState={{ selected: Boolean(selected || rowSelection.isSelected) }}
                accessibilityActions={rowAccessibilityActions}
                onAccessibilityAction={rowAccessibilityActions.length > 0 ? handleRowAccessibilityAction : undefined}
                android_ripple={Platform.OS === 'android' ? {
                    color: theme.colors.surface.ripple,
                    borderless: false,
                    foreground: true,
                } : undefined}
                onLayout={sourceTagChips.length > 0 ? handleRowLayout : undefined}
                style={[
                    styles.sessionItem,
                    isFirst ? styles.sessionItemFirst : null,
                    isLast ? styles.sessionItemLast : null,
                    compact ? styles.sessionItemCompact : null,
                    isMinimal ? styles.sessionItemMinimal : null,
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
                                monochrome={resolvedSession.active !== true || !sessionStatus.isConnected}
                                flavor={resolvedSession.metadata?.flavor}
                                hasUnreadMessages={false}
                            />
                        ) : (
                            <AgentIcon
                                agentId={agentLogoId}
                                size={agentLogoSize}
                                color={sessionTitleColor}
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
                        {!isMinimal && shouldRenderSessionListAvatar && 'draft' in resolvedSession && resolvedSession.draft ? (
                            <View style={[styles.draftIconContainer, compact ? styles.draftIconContainerCompact : null]}>
                                <Ionicons name="create-outline" size={compact ? 11 : 12} style={styles.draftIconOverlay} />
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
                    </View>

                    {showStandardSecondaryLine ? (
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
                                            animationEnabled={rowAttentionAnimationEnabled}
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
                    {showRowActions ? (
                        <View style={styles.rowActionsRow}>
                            {showSplitCanvasDragHandle ? (
                                <SessionSplitCanvasDragHandle
                                    sessionId={resolvedSession.id}
                                    onOpenInSplitRight={splitCanvasRowActions.openInSplitRight}
                                    testID={`session-item-split-drag-handle-${resolvedSession.id}`}
                                    style={styles.rowActionButton}
                                />
                            ) : null}
                            {showReorderHandle && reorderHandleGesture ? (
                                <GestureDetector gesture={reorderHandleGesture}>
                                    <View
                                        testID="session-item-reorder-handle"
                                        style={styles.rowActionButton}
                                        onPointerDown={isWeb ? suppressNextPressForPointerGesture : undefined}
                                        onPointerUp={isWeb ? suppressNextPressForPointerGesture : undefined}
                                        onPointerCancel={isWeb ? suppressNextPressForPointerGesture : undefined}
                                    >
                                        <Ionicons name="reorder-three-outline" size={16} color={rowActionIconColor} />
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
                                            icon: <Ionicons name="add" size={16} color={rowActionIconColor} />,
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
                                            <Octicons name="kebab-horizontal" size={14} color={rowActionIconColor} />
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
                                    animationEnabled={rowAttentionAnimationEnabled}
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
                            icon: <Ionicons name="add" size={16} color={rowActionIconColor} />,
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
                <Ionicons name="archive-outline" size={20} style={styles.swipeActionIcon} />
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

function SessionItemFromRowViewModel(props: SessionItemProps) {
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
    const sessionStatus = resolveSessionItemEffectiveStatus({
        rowSession,
        renderedSession: session,
        rowStatus,
    });
    const sessionNameResolved = getSessionName(session);

    return (
        <SessionItemContent
            {...itemProps}
            session={session}
            subtitleEllipsizeMode={itemProps.subtitleEllipsizeMode ?? rowViewModel.subtitleEllipsizeMode}
            serverId={itemProps.serverId}
            serverName={itemProps.serverName}
            showServerBadge={rowViewModel.showServerBadge}
            pinned={rowViewModel.pinned}
            tags={[...rowViewModel.tags]}
            tagsEnabled={itemProps.tagsEnabled}
            selected={rowViewModel.selected}
            isFirst={rowViewModel.isFirst}
            isLast={rowViewModel.isLast}
            isSingle={rowViewModel.isSingle}
            secondaryLineMode={itemProps.secondaryLineMode ?? rowViewModel.secondaryLineMode}
            activityTimeLabel={rowViewModel.activityTimeLabel}
            sessionStatus={sessionStatus}
            sessionNameResolved={sessionNameResolved}
            sessionSubtitle={itemProps.subtitleOverride ?? rowViewModel.subtitleOverride ?? getSessionSubtitle(session)}
            isSessionIdentityLoading={rowViewModel.isIdentityLoading}
            hasUnreadMessages={rowViewModel.hasUnreadMessages}
            workingIndicatorMode={rowViewModel.workingIndicatorMode}
            rowAttentionAnimationEnabled={itemProps.rowAttentionAnimationEnabled !== false}
            sessionListIdentityDisplay={normalizeSessionItemIdentityDisplay(rowViewModel.identityDisplay)}
            sessionListActiveColorMode={normalizeSessionItemActiveColorMode(rowViewModel.activeColorMode)}
            hideInactiveSessions={itemProps.hideInactiveSessions ?? rowViewModel.hideInactiveSessions}
        />
    );
}

export const SessionItem = React.memo(function SessionItem(props: SessionItemProps) {
    if (!props.rowViewModel) return null;
    return <SessionItemFromRowViewModel {...props} />;
});
