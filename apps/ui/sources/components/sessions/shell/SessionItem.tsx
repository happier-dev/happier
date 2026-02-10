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
import { sessionDelete } from '@/sync/ops';
import { useHasUnreadMessages } from '@/sync/domains/state/storage';
import { Session } from '@/sync/domains/state/storageTypes';
import { getSessionAvatarId, getSessionName, getSessionSubtitle, useSessionStatus } from '@/utils/sessions/sessionUtils';

const stylesheet = StyleSheet.create((theme) => ({
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
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
    sessionItemCompact: {
        height: 72,
        paddingHorizontal: 14,
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
    sessionContentCompact: {
        marginLeft: 12,
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
        session,
        serverId,
        serverName,
        showServerBadge,
        selected,
        isFirst,
        isLast,
        isSingle,
        variant,
        compact,
    }: {
        session: Session;
        serverId?: string;
        serverName?: string;
        showServerBadge?: boolean;
        selected?: boolean;
        isFirst?: boolean;
        isLast?: boolean;
        isSingle?: boolean;
        variant?: 'default' | 'no-path';
        compact?: boolean;
    }) => {
        const styles = stylesheet;
        const sessionStatus = useSessionStatus(session);
        const sessionNameResolved = getSessionName(session);
        const sessionSubtitle = getSessionSubtitle(session);
        const navigateToSession = useNavigateToSession();
        const isTablet = useIsTablet();
        const swipeableRef = React.useRef<Swipeable | null>(null);
        const swipeEnabled = Platform.OS !== 'web';

        const [deletingSession, performDelete] = useHappyAction(async () => {
            const result = await sessionDelete(session.id);
            if (!result.success) {
                throw new HappyError(result.message || t('sessionInfo.failedToDeleteSession'), false);
            }
        });

        const handleDelete = React.useCallback(() => {
            swipeableRef.current?.close();
            Modal.alert(t('sessionInfo.deleteSession'), t('sessionInfo.deleteSessionWarning'), [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete,
                },
            ]);
        }, [performDelete]);

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
                    selected ? styles.sessionItemSelected : null,
                ]}
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
                <View style={[styles.sessionContent, compact ? styles.sessionContentCompact : null]}>
                    <View style={styles.sessionTitleRow}>
                        <Text
                            style={[
                                styles.sessionTitle,
                                compact ? styles.sessionTitleCompact : null,
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

                    {variant !== 'no-path' ? (
                        <Text style={[styles.sessionSubtitle, compact ? styles.sessionSubtitleCompact : null]} numberOfLines={1}>
                            {sessionSubtitle}
                        </Text>
                    ) : null}

                    <View style={styles.statusRow}>
                        <View style={[styles.statusDotContainer, compact ? styles.statusDotContainerCompact : null]}>
                            <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                        </View>
                        <Text style={[styles.statusText, compact ? styles.statusTextCompact : null, { color: sessionStatus.statusColor }]}>
                            {sessionStatus.statusText}
                        </Text>
                    </View>
                </View>
            </Pressable>
        );

        const containerStyles = [
            styles.sessionItemContainer,
            isSingle ? styles.sessionItemContainerSingle : isFirst ? styles.sessionItemContainerFirst : isLast ? styles.sessionItemContainerLast : null,
        ];

        if (!swipeEnabled) {
            return <View style={containerStyles}>{itemContent}</View>;
        }

        const renderRightActions = () => (
            <Pressable style={styles.swipeAction} onPress={handleDelete} disabled={deletingSession}>
                <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                <Text style={styles.swipeActionText} numberOfLines={2}>
                    {t('sessionInfo.deleteSession')}
                </Text>
            </Pressable>
        );

        return (
            <View style={containerStyles}>
                <Swipeable
                    ref={swipeableRef}
                    renderRightActions={renderRightActions}
                    overshootRight={false}
                    enabled={!deletingSession}
                >
                    {itemContent}
                </Swipeable>
            </View>
        );
    },
);

