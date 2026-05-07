import React from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { GestureDetector, Swipeable, type ComposedGesture, type GestureType } from 'react-native-gesture-handler';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, Text as RNText } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Typography } from '@/constants/Typography';
import { formatPendingCountBadge } from '@/components/sessions/pendingBadge';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { HappyError } from '@/utils/errors/errors';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sessionArchiveWithServerScope, sessionRename, sessionSetManualReadStateWithServerScope, sessionStopWithServerScope } from '@/sync/ops';
import { useHasUnreadMessages, useSessionListMeaningfulActivityAt, useSessionListRenderable, useSetting } from '@/sync/domains/state/storage';
import { resolveSessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import { createSessionReadStateDropdownItem, resolveSessionReadStateFromActionId } from '@/components/sessions/actions/sessionReadStateActionItems';
import type { SessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionAvatarId, getSessionName, getSessionSubtitle, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { PinIcon, PinSlashIcon } from './sessionPinIcons';
import { TagIcon } from './sessionTagIcons';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { shouldEmphasizeSessionRowTitle, shouldShowMinimalSessionStatusLine } from './row/resolveSessionRowPresentation';
import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
} from './sessionListRowHeights';
import { clearSessionVisibleWhenInactive, isSessionActiveArchiveResult, stopSessionAndMaybeArchive } from '../sessionStopArchiveFlow';

const AVATAR_SIZE_DEFAULT = 48;
const AVATAR_SIZE_COMPACT = 30;
const CONTEXT_MENU_PRESS_SUPPRESSION_TIMEOUT_MS = 600;
const CONTEXT_MENU_DEFERRED_ACTION_DELAY_MS = 0;
const SESSION_IDENTITY_SKELETON_ANIMATION_MS = 900;

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
        backgroundColor: theme.colors.surface,
        borderLeftWidth: 2,
        borderRightWidth: 2,
        borderColor: theme.colors.surface,
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
        borderBottomColor: theme.colors.divider,
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
        backgroundColor: theme.colors.surfaceSelected,
        borderColor: theme.dark ? theme.colors.surfaceSelected : theme.colors.surface,
    },
    sessionTitleSelected: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    avatarContainer: {
        position: 'relative',
        width: AVATAR_SIZE_DEFAULT,
        height: AVATAR_SIZE_DEFAULT,
    },
    avatarContainerCompact: {
        width: AVATAR_SIZE_COMPACT,
        height: AVATAR_SIZE_COMPACT,
    },
    avatarLoading: {
        width: AVATAR_SIZE_DEFAULT,
        height: AVATAR_SIZE_DEFAULT,
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHighest,
    },
    avatarLoadingCompact: {
        width: AVATAR_SIZE_COMPACT,
        height: AVATAR_SIZE_COMPACT,
    },
    minimalIndicatorColumn: {
        width: 16,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
    },
    minimalUnreadDot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.textLink,
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
        borderColor: theme.colors.groupped?.background ?? 'transparent',
    },
    pendingCountContainerCompact: {
        top: -3,
        right: -3,
        minWidth: 14,
        height: 14,
    },
    pendingCountText: {
        fontSize: 8,
        color: theme.colors.textSecondary,
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
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
    draftIconContainerCompact: {
        width: 14,
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
        marginLeft: 8,
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
        color: theme.colors.textSecondary,
    },
    sessionTitleCompact: {
        fontSize: 14,
    },
    sessionTitleMinimal: {
        fontSize: 12,
        lineHeight: 16,
    },
    sessionTitleEmphasized: {
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionTitleLoading: {
        width: '68%',
        height: 14,
        borderRadius: 7,
        backgroundColor: theme.colors.surfaceHighest,
    },
    sessionTitleLoadingCompact: {
        width: '60%',
        height: 13,
        borderRadius: 7,
    },
    sessionTitleLoadingMinimal: {
        width: '56%',
        height: 12,
        borderRadius: 6,
    },
    sessionSubtitleLoading: {
        width: '46%',
        height: 10,
        borderRadius: 999,
        backgroundColor: theme.colors.surfaceHigh,
        marginTop: 3,
    },
    sessionSubtitleLoadingCompact: {
        width: '42%',
        height: 9,
        marginTop: 2,
    },
    serverBadgeContainer: {
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
        maxWidth: 140,
    },
    serverBadgeText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    rightArea: {
        marginLeft: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
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
        color: theme.colors.textSecondary,
    },
    tagsRow: {
        flexDirection: 'row',
        flexWrap: 'nowrap',
        overflow: 'hidden',
        gap: 4,
        marginTop: 4,
    },
    tagsRowCompact: {
        marginTop: 3,
    },
    tagsRowMinimal: {
        marginTop: 3,
    },
    tagChip: {
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
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
    tagChipText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
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
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        marginLeft: 8,
        overflow: 'hidden',
    },
    sessionSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
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
        lineHeight: 11
    },
    statusTextMinimal: {
        fontSize: 10,
        lineHeight: 12,
    },
    activityTime: {
        fontSize: 10,
        color: theme.colors.textSecondary,
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

export const SessionItem = React.memo(
    ({
        embedded,
        embeddedIsLast,
        session,
        subtitleOverride,
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
    }: {
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
        selected?: boolean;
        isFirst?: boolean;
        isLast?: boolean;
        isSingle?: boolean;
        variant?: 'default' | 'no-path';
        secondaryLineMode?: SessionListSecondaryLineMode;
        compact?: boolean;
        compactMinimal?: boolean;
        reorderHandleGesture?: GestureType | ComposedGesture;
        isBeingDragged?: boolean;
        nativeInlineDragEnabled?: boolean;
        nativeContextMenuOpen?: boolean;
        onNativeContextMenuOpenChange?: (next: boolean) => void;
    }) => {
        const styles = stylesheet;
        const { theme } = useUnistyles();
        const sessionId = String(session?.id ?? '').trim();
        const sessionFromStore = useSessionListRenderable(sessionId);
        const resolvedSession = sessionFromStore ?? session;
        const sessionStatus = useSessionStatus(resolvedSession);
        const sessionNameResolved = getSessionName(resolvedSession);
        const isSessionMetadataUnavailable =
            (resolvedSession as SessionListRenderableSession).metadataUnavailable === true;
        const isSessionIdentityLoading =
            !isSessionMetadataUnavailable
            && resolvedSession.metadata == null
            && sessionNameResolved === t('status.unknown');
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
        const sessionSubtitle = subtitleOverride ?? getSessionSubtitle(resolvedSession);
        const navigateToSession = useNavigateToSession();
        const swipeableRef = React.useRef<Swipeable | null>(null);
        const sessionOwnerId = typeof resolvedSession.owner === 'string' ? resolvedSession.owner : null;
        const isOwnedByCurrentUser = !sessionOwnerId || (currentUserId && sessionOwnerId === currentUserId);
        const hasAdminAccess = isOwnedByCurrentUser || resolvedSession.accessLevel === 'admin';
        const isActiveSession = resolvedSession.active === true;
        const isArchivedSession = resolvedSession.archivedAt != null;
        const isMinimal = Boolean(compact && compactMinimal);
        const canStopSession = isOwnedByCurrentUser;
        const canArchiveSession = hasAdminAccess && !isArchivedSession && (!isActiveSession || canStopSession);
        const canRenameSession = hasAdminAccess;
        const hideInactiveSessions = useSetting('hideInactiveSessions');
        const swipeEnabled = Platform.OS !== 'web' && canArchiveSession;
        const [isRowHovered, setIsRowHovered] = React.useState(false);
        const [isActionsHovered, setIsActionsHovered] = React.useState(false);
        const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
        const [tagMenuEverOpened, setTagMenuEverOpened] = React.useState(false);
        const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
        const isWeb = Platform.OS === 'web';
        const isNativeMobile = Platform.OS === 'ios' || Platform.OS === 'android';
        const showRowActions = isWeb && (isRowHovered || isActionsHovered || tagMenuOpen || moreMenuOpen || isBeingDragged === true);
        const rowActionIconColor = theme.colors.textSecondary;
        const readStateAction = React.useMemo(() => {
            if (isArchivedSession) return { kind: 'none' as const, visible: false as const };
            return resolveSessionReadStateAction(resolvedSession);
        }, [isArchivedSession, resolvedSession]);
        const readStateMenuItem = React.useMemo(
            () => createSessionReadStateDropdownItem(readStateAction, rowActionIconColor),
            [readStateAction, rowActionIconColor],
        );
        const supportsPin = typeof onTogglePinned === 'function';
        const supportsTag = tagsEnabled === true && typeof onSetTags === 'function';
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
        React.useEffect(() => {
            // When a context menu is opened by an external gesture (e.g. session list long-press),
            // Pressable may still fire `onPress` on touch-up. Suppress that navigation *once*,
            // but don't keep suppressing while the menu stays open (that would require extra taps).
            const wasOpen = contextMenuWasOpenRef.current;
            contextMenuWasOpenRef.current = contextMenuOpen;

            if (!contextMenuOpen || wasOpen) {
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
        }, [contextMenuOpen]);
        const isBeingDraggedRef = React.useRef<boolean>(false);
        React.useEffect(() => {
            isBeingDraggedRef.current = isBeingDragged === true;
        }, [isBeingDragged]);
        const handleRowHoverIn = React.useCallback(() => {
            setIsRowHovered(true);
        }, []);

        const handleRowHoverOut = React.useCallback(() => {
            setIsRowHovered(false);
        }, []);

        const handleActionsHoverIn = React.useCallback(() => {
            setIsActionsHovered(true);
        }, []);

        const handleActionsHoverOut = React.useCallback(() => {
            setIsActionsHovered(false);
        }, []);

        const stopRowPressPropagation = React.useCallback((event: unknown) => {
            const e = event as any;
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
        }, []);

        const tagMenuItems = React.useMemo((): DropdownMenuItem[] => {
            return knownTags.map((tag) => ({
                id: tag,
                title: tag,
                rightElement: activeTags.includes(tag) ? (
                    <Ionicons name="checkmark" size={16} color={rowActionIconColor} />
                ) : undefined,
            }));
        }, [knownTags, activeTags, rowActionIconColor]);

        const handleTagMenuSelect = React.useCallback((tagId: string) => {
            if (!onSetTags) return;
            const next = activeTags.includes(tagId)
                ? activeTags.filter((t) => t !== tagId)
                : [...activeTags, tagId];
            onSetTags(next);
        }, [onSetTags, activeTags]);

        const handleTagMenuCreate = React.useCallback((query: string) => {
            if (!onSetTags) return;
            const newTag = query.trim();
            if (!newTag || activeTags.includes(newTag)) return;
            onSetTags([...activeTags, newTag]);
        }, [onSetTags, activeTags]);

        const [stoppingSession, performStopMutation] = useHappyAction(async () => {
            await stopSessionAndMaybeArchive({
                sessionId: resolvedSession.id,
                hideInactiveSessions: Boolean(hideInactiveSessions),
                isPinned: Boolean(pinned),
                archiveAfterStop: 'never',
                stopSession: async () => await sessionStopWithServerScope(resolvedSession.id, { serverId: serverId ?? null }),
                archiveSession: async () => await sessionArchiveWithServerScope(resolvedSession.id, { serverId: serverId ?? null }),
                stopErrorMessage: t('sessionInfo.failedToStopSession'),
                archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
            });
        });

        const [archivingSession, performArchiveMutation] = useHappyAction(async () => {
            const stopThenArchiveSession = async () => {
                await stopSessionAndMaybeArchive({
                    sessionId: resolvedSession.id,
                    hideInactiveSessions: Boolean(hideInactiveSessions),
                    isPinned: Boolean(pinned),
                    archiveAfterStop: 'always',
                    stopSession: async () => await sessionStopWithServerScope(resolvedSession.id, { serverId: serverId ?? null }),
                    archiveSession: async () => await sessionArchiveWithServerScope(resolvedSession.id, { serverId: serverId ?? null }),
                    stopErrorMessage: t('sessionInfo.failedToStopSession'),
                    archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
                });
            };

            if (isActiveSession) {
                await stopThenArchiveSession();
                return;
            }

            const result = await sessionArchiveWithServerScope(resolvedSession.id, { serverId: serverId ?? null });
            if (!result.success) {
                if (isSessionActiveArchiveResult(result)) {
                    await stopThenArchiveSession();
                    return;
                }
                throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
            }
            clearSessionVisibleWhenInactive(resolvedSession.id);
        });
        const mutatingSession = stoppingSession || archivingSession;

        const confirmStopSession = React.useCallback(async () => {
            const confirmed = await Modal.confirm(
                t('sessionInfo.stopSession'),
                t('sessionInfo.stopSessionConfirm'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('sessionInfo.stopSession'),
                    destructive: true,
                },
            );
            if (!confirmed) return;
            await performStopMutation();
        }, [performStopMutation]);

        const confirmArchiveSession = React.useCallback(async () => {
            const confirmed = await Modal.confirm(
                t('sessionInfo.archiveSession'),
                t('sessionInfo.archiveSessionConfirm'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('sessionInfo.archiveSession'),
                    destructive: true,
                },
            );
            if (!confirmed) return;
            await performArchiveMutation();
        }, [performArchiveMutation]);

        const handleSwipeAction = React.useCallback(async () => {
            swipeableRef.current?.close();
            await confirmArchiveSession();
        }, [confirmArchiveSession]);

        const handleRenameSession = React.useCallback(async () => {
            const newName = await Modal.prompt(
                t('sessionInfo.renameSession'),
                undefined,
                {
                    defaultValue: sessionNameResolved,
                    placeholder: t('sessionInfo.renameSessionPlaceholder'),
                    confirmText: t('common.save'),
                    cancelText: t('common.cancel'),
                },
            );
            if (newName?.trim()) {
                const result = await sessionRename(resolvedSession.id, newName.trim(), { serverId: serverId ?? null });
                if (!result.success) {
                    Modal.alert(t('common.error'), result.message || t('sessionInfo.failedToRenameSession'));
                }
            }
        }, [resolvedSession.id, serverId, sessionNameResolved]);

        const handleReadStateAction = React.useCallback(async (targetState: 'read' | 'unread') => {
            const result = await sessionSetManualReadStateWithServerScope(resolvedSession.id, targetState, { serverId: serverId ?? null });
            if (!result.success) {
                Modal.alert(
                    t('common.error'),
                    result.message || t(targetState === 'read' ? 'sessionInfo.failedToMarkSessionRead' : 'sessionInfo.failedToMarkSessionUnread'),
                );
            }
        }, [resolvedSession.id, serverId]);

        const moreMenuItems = React.useMemo((): DropdownMenuItem[] => {
            const items: DropdownMenuItem[] = [];
            if (readStateMenuItem) {
                items.push(readStateMenuItem);
            }
            if (canRenameSession) {
                items.push({
                    id: 'rename',
                    title: t('sessionInfo.renameSession'),
                    icon: <Ionicons name="pencil-outline" size={16} color={rowActionIconColor} />,
                });
            }
            if (isActiveSession && canStopSession) {
                items.push({
                    id: 'stop',
                    title: t('sessionInfo.stopSession'),
                    icon: <Ionicons name="stop-circle-outline" size={16} color={rowActionIconColor} />,
                });
            }
            if (canArchiveSession) {
                items.push({
                    id: 'archive',
                    title: t('sessionInfo.archiveSession'),
                    icon: <Ionicons name="archive-outline" size={16} color={rowActionIconColor} />,
                });
            }
            return items;
        }, [canArchiveSession, canRenameSession, canStopSession, isActiveSession, readStateMenuItem, rowActionIconColor]);

        const handleMoreMenuSelect = React.useCallback(async (itemId: string) => {
            const readState = resolveSessionReadStateFromActionId(itemId);
            if (readState) {
                await handleReadStateAction(readState);
                return;
            }
            switch (itemId) {
                case 'rename':
                    handleRenameSession();
                    break;
                case 'stop':
                    await confirmStopSession();
                    break;
                case 'archive':
                    await confirmArchiveSession();
                    break;
            }
        }, [confirmArchiveSession, confirmStopSession, handleReadStateAction, handleRenameSession]);

        const contextMenuItems = React.useMemo((): DropdownMenuItem[] => {
            if (!isNativeMobile) return [];
            const items: DropdownMenuItem[] = [];
            if (supportsTag) {
                items.push({
                    id: 'tags',
                    title: t('sessionTags.editTagsLabel'),
                    icon: <TagIcon size={14} color={rowActionIconColor} />,
                });
            }
            if (supportsPin) {
                items.push({
                    id: 'pin',
                    title: pinned ? t('sessionInfo.unpinSession') : t('sessionInfo.pinSession'),
                    icon: pinned
                        ? <PinSlashIcon size={14} color={rowActionIconColor} />
                        : <PinIcon size={14} color={rowActionIconColor} />,
                });
            }
            items.push(...moreMenuItems);
            return items;
        }, [isNativeMobile, moreMenuItems, pinned, rowActionIconColor, supportsPin, supportsTag]);

        const handleContextMenuSelect = React.useCallback((itemId: string) => {
            if (itemId === 'tags') {
                setContextMenuOpen(false);
                setTagMenuEverOpened(true);
                setTagMenuOpen(true);
                return;
            }
            if (itemId === 'pin') {
                setContextMenuOpen(false);
                onTogglePinned?.();
                return;
            }
            if (itemId === 'rename') {
                setContextMenuOpen(false);
                setTimeout(() => {
                    void handleMoreMenuSelect(itemId);
                }, CONTEXT_MENU_DEFERRED_ACTION_DELAY_MS);
                return;
            }
            setContextMenuOpen(false);
            void handleMoreMenuSelect(itemId);
        }, [handleMoreMenuSelect, onTogglePinned]);

        const avatarId = React.useMemo(() => {
            return getSessionAvatarId(resolvedSession);
        }, [resolvedSession]);
        const hasUnreadMessages = useHasUnreadMessages(resolvedSession.id);
        const pendingCount = resolvedSession.pendingCount ?? 0;
        const pendingBadge = formatPendingCountBadge(pendingCount);
        const meaningfulActivityAt = useSessionListMeaningfulActivityAt(resolvedSession.id);

        const activityTimeLabel = React.useMemo(() => {
            const ts = meaningfulActivityAt;
            return typeof ts === 'number' && ts > 0 ? formatShortRelativeTime(ts) : '';
        }, [meaningfulActivityAt]);
        const tagChipDensity: 'default' | 'compact' | 'minimal' = isMinimal ? 'minimal' : compact ? 'compact' : 'default';
        const tagLimit = isMinimal ? 1 : compact ? 2 : 3;
        const tagChips = React.useMemo(() => {
            if (!tagsEnabled || activeTags.length === 0) return [];
            const slice = activeTags.slice(0, tagLimit);
            const remaining = activeTags.length - slice.length;
            if (remaining <= 0) return slice.map((tag) => ({ key: tag, label: tag, isOverflow: false }));
            return [
                ...slice.map((tag) => ({ key: tag, label: tag, isOverflow: false })),
                { key: '__more__', label: `+${remaining}`, isOverflow: true },
            ];
        }, [activeTags, tagLimit, tagsEnabled]);
        const fallbackSecondaryLineMode: SessionListSecondaryLineMode = variant === 'no-path' ? 'status' : 'path';
        const requestedSecondaryLineMode = secondaryLineMode ?? fallbackSecondaryLineMode;
        const effectiveSecondaryLineMode: SessionListSecondaryLineMode =
            requestedSecondaryLineMode === 'path'
                ? (sessionSubtitle ? 'path' : 'status')
                : (sessionStatus.statusText ? 'status' : sessionSubtitle ? 'path' : 'status');
        const effectiveSubtitleEllipsizeMode = subtitleEllipsizeMode ?? 'head';
        const shouldUsePathSubtitleStartEllipsis = effectiveSecondaryLineMode === 'path' && effectiveSubtitleEllipsizeMode === 'head';
        const shouldUseWebPathSubtitleStartEllipsis = shouldUsePathSubtitleStartEllipsis && isWeb;
        const showMinimalStatusLine = isMinimal && shouldShowMinimalSessionStatusLine(sessionStatus);
        const shouldShowIdentitySubtitleSkeleton = !isMinimal && isSessionIdentityLoading && requestedSecondaryLineMode === 'path';
        const showStandardSecondaryLine = !isMinimal && (
            shouldShowIdentitySubtitleSkeleton
            || effectiveSecondaryLineMode === 'status'
            || Boolean(sessionSubtitle)
        );
        const shouldEmphasizeTitle = shouldEmphasizeSessionRowTitle({
            hasUnreadMessages,
            pendingCount,
            sessionStatus,
        });
        const showTagChips = tagChips.length > 0 && (!isMinimal || !showMinimalStatusLine);
        const enableLongPressContextMenu =
            Platform.OS === 'ios'
            && contextMenuItems.length > 0
            && (nativeInlineDragEnabled !== true || showReorderHandle);

        const shouldRenderAvatarMonochrome = resolvedSession.active !== true || !sessionStatus.isConnected;

        const itemContent = (
            <Pressable
                testID={`session-list-item-${resolvedSession.id}`}
                accessibilityState={{ selected }}
                style={[
                    styles.sessionItem,
                    isFirst ? styles.sessionItemFirst : null,
                    isLast ? styles.sessionItemLast : null,
                    compact ? styles.sessionItemCompact : null,
                    isMinimal ? styles.sessionItemMinimal : null,
                    selected ? styles.sessionItemSelected : null,
                    embedded && !embeddedIsLast ? styles.embeddedSeparator : null,
                ]}
                onHoverIn={isWeb ? handleRowHoverIn : undefined}
                onHoverOut={isWeb ? handleRowHoverOut : undefined}
                onPress={() => {
                    if (suppressNextPressRef.current) {
                        suppressNextPressRef.current = false;
                        return;
                    }
                    if (contextMenuOpen) {
                        setContextMenuOpen(false);
                    }
                    navigateToSession(resolvedSession.id, serverId ? { serverId } : undefined);
                }}
                onLongPress={enableLongPressContextMenu ? () => {
                    if (isBeingDraggedRef.current) return;
                    suppressNextPressRef.current = true;
                    setContextMenuOpen(true);
                } : undefined}
            >
                {isMinimal ? (
                    <View style={styles.minimalIndicatorColumn}>
                        {hasUnreadMessages ? <View style={styles.minimalUnreadDot} /> : null}
                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                    </View>
                ) : (
                    <View style={[styles.avatarContainer, compact ? styles.avatarContainerCompact : null]}>
                        {isSessionIdentityLoading ? (
                            <Animated.View
                                testID={`session-list-avatar-loading-${resolvedSession.id}`}
                                style={[
                                    styles.avatarLoading,
                                    compact ? styles.avatarLoadingCompact : null,
                                    { opacity: identitySkeletonOpacity },
                                ]}
                            />
                        ) : (
                            <Avatar
                                id={avatarId}
                                size={compact ? AVATAR_SIZE_COMPACT : AVATAR_SIZE_DEFAULT}
                                monochrome={shouldRenderAvatarMonochrome}
                                flavor={resolvedSession.metadata?.flavor}
                                hasUnreadMessages={hasUnreadMessages}
                            />
                        )}
                        {pendingBadge ? (
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
                        {'draft' in resolvedSession && resolvedSession.draft ? (
                            <View style={[styles.draftIconContainer, compact ? styles.draftIconContainerCompact : null]}>
                                <Ionicons name="create-outline" size={compact ? 10 : 11} style={styles.draftIconOverlay} />
                            </View>
                        ) : null}
                    </View>
                )}
                <View
                    style={[
                        styles.sessionContent,
                        compact ? styles.sessionContentCompact : null,
                        isMinimal ? styles.sessionContentMinimal : null,
                    ]}
                >
                    <View style={styles.sessionTitleRow}>
                        {isSessionIdentityLoading ? (
                            <Animated.View
                                testID={`session-list-title-loading-${resolvedSession.id}`}
                                style={[
                                    styles.sessionTitleLoading,
                                    compact ? styles.sessionTitleLoadingCompact : null,
                                    isMinimal ? styles.sessionTitleLoadingMinimal : null,
                                    { opacity: identitySkeletonOpacity },
                                ]}
                            />
                        ) : (
                            <Text
                                style={[
                                    styles.sessionTitle,
                                    compact ? styles.sessionTitleCompact : null,
                                    isMinimal ? styles.sessionTitleMinimal : null,
                                    shouldEmphasizeTitle ? styles.sessionTitleEmphasized : null,
                                    sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
                                    selected ? styles.sessionTitleSelected : null,
                                ]}
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

                    {showMinimalStatusLine ? (
                        <View style={[styles.secondaryLineRow, styles.secondaryLineRowMinimal]}>
                            <View
                                style={[
                                    styles.secondaryStatusDotContainer,
                                    styles.secondaryStatusDotContainerMinimal,
                                ]}
                            >
                                <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                            </View>
                            <Text
                                style={[
                                    styles.statusText,
                                    styles.statusTextMinimal,
                                    { color: sessionStatus.statusColor },
                                ]}
                                numberOfLines={1}
                            >
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    ) : null}

                    {showStandardSecondaryLine ? (
                        shouldShowIdentitySubtitleSkeleton ? (
                            <Animated.View
                                testID={`session-list-subtitle-loading-${resolvedSession.id}`}
                                style={[
                                    styles.sessionSubtitleLoading,
                                    compact ? styles.sessionSubtitleLoadingCompact : null,
                                    { opacity: identitySkeletonOpacity },
                                ]}
                            />
                        ) : effectiveSecondaryLineMode === 'status' ? (
                            <View style={styles.secondaryLineRow}>
                                <View
                                    style={[
                                        styles.secondaryStatusDotContainer,
                                        compact ? styles.secondaryStatusDotContainerCompact : null,
                                    ]}
                                >
                                    <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                                </View>
                                <Text
                                    style={[
                                        styles.statusText,
                                        compact ? styles.statusTextCompact : null,
                                        { color: sessionStatus.statusColor },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {sessionStatus.statusText}
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

                    {showTagChips ? (
                        <View
                            style={[
                                styles.tagsRow,
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
                    ) : null}
                </View>
                <View
                    testID="session-item-right-area"
                    style={styles.rightArea}
                    onPointerEnter={isWeb ? handleActionsHoverIn : undefined}
                    onPointerLeave={isWeb ? handleActionsHoverOut : undefined}
                >
                    {showRowActions ? (
                        <View style={styles.rowActionsRow}>
                            {showReorderHandle && reorderHandleGesture ? (
                                <GestureDetector gesture={reorderHandleGesture}>
                                    <View testID="session-item-reorder-handle" style={styles.rowActionButton}>
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
                                        onTogglePinned?.();
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
                                            <Octicons name="kebab-horizontal" size={14} color={rowActionIconColor} />
                                        </Pressable>
                                    )}
                                />
                            ) : null}
                        </View>
                    ) : (
                        activityTimeLabel ? (
                            <Text
                                style={[styles.activityTime, isMinimal ? styles.activityTimeMinimal : null]}
                                numberOfLines={1}
                            >
                                {activityTimeLabel}
                            </Text>
                        ) : null
                    )}
                </View>
            </Pressable>
        );

        const containerStyles = [
            embedded ? styles.sessionItemContainerEmbedded : styles.sessionItemContainer,
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
                <View ref={contextMenuAnchorRef} collapsable={false} style={containerStyles}>
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
            <View ref={contextMenuAnchorRef} collapsable={false} style={containerStyles}>
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
