import React from 'react';
import { View, Pressable, FlatList, Platform } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Text } from '@/components/ui/text/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, useHasUnreadMessages } from '@/sync/domains/state/storage';
import { Ionicons } from '@expo/vector-icons';
import { getSessionName, useSessionStatus, getSessionSubtitle, getSessionAvatarId } from '@/utils/sessions/sessionUtils';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { ActiveSessionsGroup } from './ActiveSessionsGroup';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSetting } from '@/sync/domains/state/storage';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/domains/state/storageTypes';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/platform/responsive';
import { requestReview } from '@/utils/system/requestReview';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { layout } from '@/components/ui/layout/layout';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { sessionDelete } from '@/sync/ops';
import { HappyError } from '@/utils/errors/errors';
import { formatPendingCountBadge } from '@/components/sessions/pendingBadge';
import { Modal } from '@/modal';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    projectGroup: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
    },
    projectGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    projectGroupSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
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
        sessionItemContainer: {
            marginHorizontal: 16,
            marginBottom: 1,
            overflow: 'hidden',
        },
    sessionItemFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
    },
    sessionItemSingle: {
        borderRadius: 12,
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
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
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
    artifactsSection: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: theme.colors.groupped.background,
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

export function SessionsList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const data = useVisibleSessionListViewData();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const navigateToSession = useNavigateToSession();
    const compactSessionView = useSetting('compactSessionView');
    const multiServerEnabled = useSetting('multiServerEnabled');
    const multiServerPresentation = useSetting('multiServerPresentation');
    const router = useRouter();
    const selectable = isTablet;
    const dataWithSelected = selectable ? React.useMemo(() => {
        return data?.map(item => ({
            ...item,
            selected: pathname.startsWith(`/session/${item.type === 'session' ? item.session.id : ''}`)
        }));
    }, [data, pathname]) : data;

    // Request review
    React.useEffect(() => {
        if (data && data.length > 0) {
            requestReview();
        }
    }, [data && data.length > 0]);

    // Early return if no data yet
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListViewItem & { selected?: boolean }, index: number) => {
        const serverPrefix = item.serverId ? `${item.serverId}:` : '';
        switch (item.type) {
            case 'header': return `${serverPrefix}header-${item.title}-${index}`;
            case 'active-sessions': return `${serverPrefix}active-sessions`;
            case 'project-group': return `${serverPrefix}project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'session': return `${serverPrefix}session-${item.session.id}`;
        }
    }, []);

        const renderItem = React.useCallback(({ item, index }: { item: SessionListViewItem & { selected?: boolean }, index: number }) => {
        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {item.headerKind === 'server' ? `Server: ${item.title}` : item.title}
                        </Text>
                    </View>
                );

            case 'active-sessions':
                // Extract just the session ID from pathname (e.g., /session/abc123/file -> abc123)
                let selectedId: string | undefined;
                if (isTablet && pathname.startsWith('/session/')) {
                    const parts = pathname.split('/');
                    selectedId = parts[2]; // parts[0] is empty, parts[1] is 'session', parts[2] is the ID
                }

                const ActiveComponent = compactSessionView ? ActiveSessionsGroupCompact : ActiveSessionsGroup;
                return (
                    <ActiveComponent
                        sessions={item.sessions}
                        selectedSessionId={selectedId}
                    />
                );

            case 'project-group':
                return (
                    <View style={styles.projectGroup}>
                        <Text style={styles.projectGroupTitle}>
                            {item.displayPath}
                        </Text>
                        <Text style={styles.projectGroupSubtitle}>
                            {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </View>
                );

                case 'session':
                // Determine card styling based on position within date group
                const prevItem = index > 0 && dataWithSelected ? dataWithSelected[index - 1] : null;
                const nextItem = index < (dataWithSelected?.length || 0) - 1 && dataWithSelected ? dataWithSelected[index + 1] : null;

                const isFirst = prevItem?.type === 'header' || prevItem?.type === 'project-group';
                const isLast = nextItem?.type === 'header' || nextItem?.type === 'project-group' || nextItem == null || nextItem?.type === 'active-sessions';
                const isSingle = isFirst && isLast;

                    return (
                        <SessionItem
                            session={item.session}
                            serverName={item.serverName}
                            showServerBadge={multiServerEnabled && multiServerPresentation === 'flat-with-badge'}
                            selected={item.selected}
                            isFirst={isFirst}
                            isLast={isLast}
                            isSingle={isSingle}
                            variant={item.variant}
                            compact={compactSessionView}
                        />
                    );
            }
        }, [pathname, dataWithSelected, compactSessionView, multiServerEnabled, multiServerPresentation]);


    // Remove this section as we'll use FlatList for all items now


    const HeaderComponent = React.useCallback(() => {
        return (
            <View>
                <RecoveryKeyReminderBanner />
                <UpdateBanner />
            </View>
        );
    }, []);

    // Footer removed - all sessions now shown inline

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={dataWithSelected}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ paddingBottom: safeArea.bottom + 128, maxWidth: layout.maxWidth }}
                    ListHeaderComponent={HeaderComponent}
                />
            </View>
        </View>
    );
}

// Sub-component that handles session message logic
const SessionItem = React.memo(({ session, serverName, showServerBadge, selected, isFirst, isLast, isSingle, variant, compact }: {
        session: Session;
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
    const sessionName = getSessionName(session);
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
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete
                }
            ]
        );
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
                    selected && styles.sessionItemSelected,
                    isSingle ? styles.sessionItemSingle :
                        isFirst ? styles.sessionItemFirst :
                            isLast ? styles.sessionItemLast : {}
                ]}
            onPressIn={() => {
                if (isTablet) {
                    navigateToSession(session.id);
                }
            }}
            onPress={() => {
                if (!isTablet) {
                    navigateToSession(session.id);
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
                    {pendingBadge && (
                        <View style={[styles.pendingCountContainer, compact ? styles.pendingCountContainerCompact : null]}>
                            <Text style={styles.pendingCountText} numberOfLines={1}>
                                {pendingBadge}
                            </Text>
                        </View>
                    )}
                    {session.draft && (
                        <View style={[styles.draftIconContainer, compact ? styles.draftIconContainerCompact : null]}>
                            <Ionicons
                                name="create-outline"
                                size={compact ? 11 : 12}
                                style={styles.draftIconOverlay}
                            />
                        </View>
                    )}
                </View>
                <View style={[styles.sessionContent, compact ? styles.sessionContentCompact : null]}>
                    {/* Title line */}
                    <View style={styles.sessionTitleRow}>
                        <Text style={[
                            styles.sessionTitle,
                            compact ? styles.sessionTitleCompact : null,
                            sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                        ]} numberOfLines={1}> {/* {variant !== 'no-path' ? 1 : 2} - issue is we don't have anything to take this space yet and it looks strange - if summaries were more reliably generated, we can add this. While no summary - add something like "New session" or "Empty session", and extend summary to 2 lines once we have it */}
                            {sessionName}
                        </Text>
                        {showServerBadge && serverName ? (
                            <View style={styles.serverBadgeContainer}>
                                <Text style={styles.serverBadgeText} numberOfLines={1}>
                                    {serverName}
                                </Text>
                            </View>
                        ) : null}
                    </View>
    
                    {/* Subtitle line */}
                    {variant !== 'no-path' && (
                        <Text style={[styles.sessionSubtitle, compact ? styles.sessionSubtitleCompact : null]} numberOfLines={1}>
                            {sessionSubtitle}
                        </Text>
                    )}
    
                    {/* Status line with dot */}
                    <View style={styles.statusRow}>
                        <View style={[styles.statusDotContainer, compact ? styles.statusDotContainerCompact : null]}>
                            <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                        </View>
                        <Text style={[
                            styles.statusText,
                            compact ? styles.statusTextCompact : null,
                            { color: sessionStatus.statusColor }
                        ]}>
                            {sessionStatus.statusText}
                        </Text>
                    </View>
                </View>
            </Pressable>
        );

    const containerStyles = [
        styles.sessionItemContainer,
        isSingle ? styles.sessionItemContainerSingle :
            isFirst ? styles.sessionItemContainerFirst :
                isLast ? styles.sessionItemContainerLast : {}
    ];

    if (!swipeEnabled) {
        return (
            <View style={containerStyles}>
                {itemContent}
            </View>
        );
    }

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeAction}
            onPress={handleDelete}
            disabled={deletingSession}
        >
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
});
