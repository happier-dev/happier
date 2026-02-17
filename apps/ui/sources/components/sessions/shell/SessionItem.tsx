import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/StyledText';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Typography } from '@/constants/Typography';
import { formatPendingCountBadge } from '@/components/sessions/pendingBadge';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useIsTablet } from '@/utils/platform/responsive';
import { HappyError } from '@/utils/errors/errors';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sessionArchiveWithServerScope, sessionStopWithServerScope } from '@/sync/ops';
import { useHasUnreadMessages, useProfile } from '@/sync/domains/state/storage';
import { Session } from '@/sync/domains/state/storageTypes';
import { getSessionAvatarId, getSessionName, getSessionSubtitle, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { PinIcon, PinSlashIcon } from './sessionPinIcons';

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
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
    },
    embeddedSeparator: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    sessionItemCompact: {
        height: 72,
        paddingHorizontal: 14,
    },
    sessionItemMinimal: {
        height: 52,
        paddingHorizontal: 12,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    avatarContainer: {
        position: 'relative',
        width: 48,
        height: 48,
    },
    avatarContainerCompact: {
        width: 40,
        height: 40,
    },
    minimalIndicatorColumn: {
        width: 18,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    minimalUnreadDot: {
        width: 7,
        height: 7,
        borderRadius: 999,
        backgroundColor: theme.colors.textLink,
        borderWidth: 1,
        borderColor: theme.colors.surface,
    },
    pendingCountContainer: {
        position: 'absolute',
        top: -4,
        right: -6,
        minWidth: 18,
        height: 18,
        paddingHorizontal: 6,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.groupped?.background ?? 'transparent',
    },
    pendingCountContainerCompact: {
        top: -3,
        right: -5,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 5,
    },
    pendingCountText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
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
        color: theme.colors.textSecondary,
    },
    draftIconContainerCompact: {
        width: 16,
        height: 16,
        bottom: -1,
        right: -1,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
        justifyContent: 'center',
    },
    sessionContentWithActions: {
        paddingRight: 36,
    },
    sessionContentCompact: {
        marginLeft: 12,
    },
    sessionContentMinimal: {
        marginLeft: 10,
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
        gap: 6,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionTitleCompact: {
        fontSize: 14,
    },
    sessionTitleMinimal: {
        fontSize: 13,
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
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
    rowActionsOverlay: {
        position: 'absolute',
        right: 10,
        top: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
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
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default(),
    },
    sessionSubtitleCompact: {
        fontSize: 12,
        marginBottom: 3,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusDotContainerCompact: {
        marginTop: 1,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    statusTextCompact: {
        fontSize: 11,
        lineHeight: 14,
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
        color: '#FFFFFF',
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
        serverId,
        serverName,
        showServerBadge,
        pinned,
        onTogglePinned,
        selected,
        isFirst,
        isLast,
        isSingle,
        variant,
        compact,
        compactMinimal,
    }: {
        embedded?: boolean;
        embeddedIsLast?: boolean;
        session: Session;
        subtitleOverride?: string | null;
        serverId?: string;
        serverName?: string;
        showServerBadge?: boolean;
        pinned?: boolean;
        onTogglePinned?: (() => void) | null;
        selected?: boolean;
        isFirst?: boolean;
        isLast?: boolean;
        isSingle?: boolean;
        variant?: 'default' | 'no-path';
        compact?: boolean;
        compactMinimal?: boolean;
    }) => {
        const styles = stylesheet;
        const sessionStatus = useSessionStatus(session);
        const sessionNameResolved = getSessionName(session);
        const sessionSubtitle = subtitleOverride ?? getSessionSubtitle(session);
        const navigateToSession = useNavigateToSession();
        const isTablet = useIsTablet();
        const swipeableRef = React.useRef<Swipeable | null>(null);
        const profile = useProfile();
        const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
        const sessionOwnerId = typeof session.owner === 'string' ? session.owner : null;
        const isOwnedByCurrentUser = !sessionOwnerId || (currentUserId && sessionOwnerId === currentUserId);
        const hasAdminAccess = isOwnedByCurrentUser || session.accessLevel === 'admin';
        const isActiveSession = session.active === true;
        const isMinimal = Boolean(compact && compactMinimal);
        const canStopSession = isOwnedByCurrentUser;
        const canArchiveSession = hasAdminAccess && !isActiveSession;
        const swipeEnabled = Platform.OS !== 'web' && (isActiveSession ? canStopSession : canArchiveSession);
        const [isHoveringRow, setIsHoveringRow] = React.useState(false);
        const [isHoveringPin, setIsHoveringPin] = React.useState(false);
        const showRowActions = Platform.OS !== 'web' || isHoveringRow || isHoveringPin;
        const rowActionIconColor = String((styles.rowActionIcon as any)?.color ?? '#666');
        const supportsPin = typeof onTogglePinned === 'function';
        const showPinAction = supportsPin && showRowActions;
        const hoverOutTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
        const isHoveringPinRef = React.useRef(false);

        React.useEffect(() => {
            isHoveringPinRef.current = isHoveringPin;
        }, [isHoveringPin]);

        const clearHoverOutTimeout = React.useCallback(() => {
            if (hoverOutTimeoutRef.current) {
                clearTimeout(hoverOutTimeoutRef.current);
                hoverOutTimeoutRef.current = null;
            }
        }, []);

        React.useEffect(() => {
            return () => {
                clearHoverOutTimeout();
            };
        }, [clearHoverOutTimeout]);

        const handleRowHoverIn = React.useCallback(() => {
            clearHoverOutTimeout();
            setIsHoveringRow(true);
        }, [clearHoverOutTimeout]);

        const handleRowHoverOut = React.useCallback(() => {
            clearHoverOutTimeout();
            // Web hover can flicker when moving between nested pressables.
            // Keep this delay effectively immediate; any lingering feels like a bug when leaving the row.
            hoverOutTimeoutRef.current = setTimeout(() => {
                if (!isHoveringPinRef.current) {
                    setIsHoveringRow(false);
                }
            }, 0);
        }, [clearHoverOutTimeout]);

        const handlePinHoverIn = React.useCallback(() => {
            clearHoverOutTimeout();
            setIsHoveringPin(true);
        }, [clearHoverOutTimeout]);

        const handlePinHoverOut = React.useCallback(() => {
            clearHoverOutTimeout();
            // Hide promptly when leaving the pin button.
            hoverOutTimeoutRef.current = setTimeout(() => {
                setIsHoveringPin(false);
                setIsHoveringRow(false);
            }, 0);
        }, [clearHoverOutTimeout]);

        const [mutatingSession, performMutation] = useHappyAction(async () => {
            const result = isActiveSession
                ? await sessionStopWithServerScope(session.id, { serverId: serverId ?? null })
                : await sessionArchiveWithServerScope(session.id, { serverId: serverId ?? null });
            if (!result.success) {
                throw new HappyError(
                    result.message || (isActiveSession ? t('sessionInfo.failedToStopSession') : t('sessionInfo.failedToArchiveSession')),
                    false
                );
            }
        });

        const handleSwipeAction = React.useCallback(() => {
            swipeableRef.current?.close();
            if (isActiveSession) {
                Modal.alert(t('sessionInfo.stopSession'), t('sessionInfo.stopSessionConfirm'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('sessionInfo.stopSession'),
                        style: 'destructive',
                        onPress: performMutation,
                    },
                ]);
                return;
            }
            Modal.alert(t('sessionInfo.archiveSession'), t('sessionInfo.archiveSessionConfirm'), [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.archiveSession'),
                    style: 'destructive',
                    onPress: performMutation,
                },
            ]);
        }, [isActiveSession, performMutation]);

        const avatarId = React.useMemo(() => {
            return getSessionAvatarId(session);
        }, [session]);
        const hasUnreadMessages = useHasUnreadMessages(session.id);
        const pendingCount = session.pendingCount ?? 0;
        const pendingBadge = formatPendingCountBadge(pendingCount);

        const itemContent = (
            <Pressable
                style={[
                    styles.sessionItem,
                    compact ? styles.sessionItemCompact : null,
                    isMinimal ? styles.sessionItemMinimal : null,
                    selected ? styles.sessionItemSelected : null,
                    embedded && !embeddedIsLast ? styles.embeddedSeparator : null,
                ]}
                onHoverIn={Platform.OS === 'web' ? handleRowHoverIn : undefined}
                onHoverOut={Platform.OS === 'web' ? handleRowHoverOut : undefined}
                onPressIn={() => {
                    if (isTablet) {
                        navigateToSession(session.id, serverId ? { serverId } : undefined);
                    }
                }}
                onPress={() => {
                    if (!isTablet) {
                        navigateToSession(session.id, serverId ? { serverId } : undefined);
                    }
                }}
            >
                {isMinimal ? (
                    <View style={styles.minimalIndicatorColumn}>
                        {hasUnreadMessages ? <View style={styles.minimalUnreadDot} /> : null}
                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                    </View>
                ) : (
                    <View style={[styles.avatarContainer, compact ? styles.avatarContainerCompact : null]}>
                        <Avatar
                            id={avatarId}
                            size={compact ? 40 : 48}
                            monochrome={!sessionStatus.isConnected}
                            flavor={session.metadata?.flavor}
                            hasUnreadMessages={hasUnreadMessages}
                        />
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
                        {session.draft ? (
                            <View style={[styles.draftIconContainer, compact ? styles.draftIconContainerCompact : null]}>
                                <Ionicons name="create-outline" size={compact ? 11 : 12} style={styles.draftIconOverlay} />
                            </View>
                        ) : null}
                    </View>
                )}
                <View
                    style={[
                        styles.sessionContent,
                        compact ? styles.sessionContentCompact : null,
                        isMinimal ? styles.sessionContentMinimal : null,
                        supportsPin ? styles.sessionContentWithActions : null,
                    ]}
                >
                    <View style={styles.sessionTitleRow}>
                        <Text
                            style={[
                                styles.sessionTitle,
                                compact ? styles.sessionTitleCompact : null,
                                isMinimal ? styles.sessionTitleMinimal : null,
                                sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
                            ]}
                            numberOfLines={1}
                        >
                            {sessionNameResolved}
                        </Text>
                    {showServerBadge && serverName ? (
                        <View style={styles.serverBadgeContainer}>
                            <Text style={styles.serverBadgeText} numberOfLines={1}>
                                {serverName}
                            </Text>
                        </View>
                    ) : null}
                </View>

                    {!isMinimal && (variant !== 'no-path' || subtitleOverride) ? (
                        <Text style={[styles.sessionSubtitle, compact ? styles.sessionSubtitleCompact : null]} numberOfLines={1}>
                            {sessionSubtitle}
                        </Text>
                    ) : null}

                    {!isMinimal ? (
                        <View style={styles.statusRow}>
                            <View style={[styles.statusDotContainer, compact ? styles.statusDotContainerCompact : null]}>
                                <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                            </View>
                            <Text style={[styles.statusText, compact ? styles.statusTextCompact : null, { color: sessionStatus.statusColor }]}>
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    ) : null}
                </View>
                {supportsPin ? (
                    <View
                        style={[
                            styles.rowActionsOverlay,
                            {
                                top: isMinimal ? 6 : compact ? 8 : 10,
                                opacity: showPinAction ? 1 : 0,
                            },
                        ]}
                        pointerEvents={showPinAction ? 'auto' : 'none'}
                    >
                        <Pressable
                            style={styles.rowActionButton}
                            onPress={onTogglePinned}
                            onHoverIn={Platform.OS === 'web' ? handlePinHoverIn : undefined}
                            onHoverOut={Platform.OS === 'web' ? handlePinHoverOut : undefined}
                            accessibilityRole="button"
                            accessibilityLabel={pinned ? 'Unpin session' : 'Pin session'}
                            hitSlop={8}
                        >
                            {pinned ? (
                                <PinSlashIcon size={14} color={rowActionIconColor} />
                            ) : (
                                <PinIcon size={14} color={rowActionIconColor} />
                            )}
                        </Pressable>
                    </View>
                ) : null}
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

        if (!swipeEnabled) {
            return <View style={containerStyles}>{itemContent}</View>;
        }

        const renderRightActions = () => (
            <Pressable style={styles.swipeAction} onPress={handleSwipeAction} disabled={mutatingSession}>
                <Ionicons name={isActiveSession ? 'stop-circle-outline' : 'archive-outline'} size={20} color="#FFFFFF" />
                <Text style={styles.swipeActionText} numberOfLines={2}>
                    {isActiveSession ? t('sessionInfo.stopSession') : t('sessionInfo.archiveSession')}
                </Text>
            </Pressable>
        );

        return (
            <View style={containerStyles}>
                <Swipeable
                    ref={swipeableRef}
                    renderRightActions={renderRightActions}
                    overshootRight={false}
                    enabled={!mutatingSession}
                >
                    {itemContent}
                </Swipeable>
            </View>
        );
    },
);
