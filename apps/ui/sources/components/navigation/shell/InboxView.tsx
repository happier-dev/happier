import * as React from 'react';
import { View, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    useAllSessionListAttentionRows,
    useAllSessionsForAttention,
    useArtifacts,
    useFeedItems,
    useFeedLoaded,
    useFriendRequests,
    useFriendsLoaded,
    useRequestedFriends,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { useIsTablet } from '@/utils/platform/responsive';
import { Header } from '@/components/navigation/Header';
import { Image } from 'expo-image';
import { FeedItemCard } from '@/components/inbox/cards/FeedItemCard';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { Text } from '@/components/ui/text/Text';
import { UserCard } from '@/components/ui/cards/UserCard';
import { trackFriendsProfileView } from '@/track';
import { ApprovalInboxCard } from '@/components/inbox/cards/ApprovalInboxCard';
import { isOpenApprovalInboxArtifact } from '@/components/approvals/approvalInboxHeader';
import { InboxSessionAttentionGroupCard } from '@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { buildInboxSessionState } from '@/hooks/inbox/buildInboxSessionState';
import { useInboxSessionMessagesById } from '@/hooks/inbox/useInboxSessionMessagesById';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    scrollContent: {
        alignSelf: 'center',
        width: '100%',
        // Lets the loading/empty body fill the viewport so it keeps the centered
        // composition it had while it was rendered outside the scroll container.
        flexGrow: 1,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyIcon: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyDescription: {
        fontSize: 16,
        ...Typography.default(),
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 22,
    },
}));

interface InboxViewProps {}

// Header components for tablet mode only (phone mode header is in MainView)
function HeaderTitleTablet() {
    const { theme } = useUnistyles();
    return (
        <Text style={{
            fontSize: 17,
            color: theme.colors.chrome.header.foreground,
            fontWeight: '600',
            ...Typography.default('semiBold'),
        }}>
            {t('tabs.inbox')}
        </Text>
    );
}

export const InboxView = React.memo(({}: InboxViewProps) => {
    const router = useRouter();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
    const artifacts = useArtifacts();
    const feedLoaded = useFeedLoaded();
    const friendsLoaded = useFriendsLoaded();
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    // Read at render time so the user's content-width preference keeps applying
    // here; a module-scope stylesheet would freeze it at the first evaluation.
    const contentMaxWidth = useLayoutMaxWidth();
    const scrollContentStyle = React.useMemo(
        () => [styles.scrollContent, { maxWidth: contentMaxWidth }],
        [contentMaxWidth],
    );
    const friendsEnabled = useFriendsEnabled();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const sessions = useAllSessionsForAttention();
    const sessionRows = useAllSessionListAttentionRows();
    const sessionMessagesById = useInboxSessionMessagesById({
        sessions,
        sessionRows,
    });
    const { unreadSessions, sessionsNeedingAttention } = React.useMemo(
        () => buildInboxSessionState({ sessions, sessionRows, sessionMessagesById }),
        [sessionMessagesById, sessionRows, sessions],
    );

    const openApprovals = React.useMemo(
        () => artifacts.filter(isOpenApprovalInboxArtifact),
        [artifacts],
    );

    const showFriendsActivity = friendsEnabled && friendsIdentityReady;

    const isLoading = friendsEnabled ? (!feedLoaded || !friendsLoaded) : false;
    const isEmpty = !isLoading &&
        openApprovals.length === 0 &&
        sessionsNeedingAttention.length === 0 &&
        unreadSessions.length === 0 &&
        (!showFriendsActivity || (
            friendRequests.length === 0 &&
            requestedFriends.length === 0 &&
            feedItems.length === 0
        ));

    // `isLoading` and `isEmpty` are transient — the inbox flips between them
    // while the surface is open (an item arrives, the last unread is read). They
    // may only change what renders inside the scroll container, never whether
    // that container is mounted, so the ScrollView keeps its identity and offset.
    const body: 'loading' | 'empty' | 'content' = isLoading
        ? 'loading'
        : isEmpty
            ? 'empty'
            : 'content';

    return (
        <View style={styles.container}>
            {isTablet && (
                <View style={{ backgroundColor: theme.colors.background.canvas }}>
                    <Header
                        title={<HeaderTitleTablet />}
                        headerRight={() => null}
                        headerLeft={() => null}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                </View>
            )}
            <ScrollView contentContainerStyle={scrollContentStyle}>
                <RecoveryKeyReminderBanner />

                {body === 'loading' && (
                    <View style={styles.emptyContainer}>
                        <ActivitySpinner size="large" color={theme.colors.text.secondary} />
                    </View>
                )}

                {body === 'empty' && (
                    <View style={styles.emptyContainer}>
                        <Image
                            source={require('@/assets/images/brutalist/Brutalism 10.png')}
                            contentFit="contain"
                            style={[{ width: 64, height: 64 }, styles.emptyIcon]}
                            tintColor={theme.colors.text.secondary}
                        />
                        <Text style={styles.emptyTitle}>{t('inbox.emptyTitle')}</Text>
                        <Text style={styles.emptyDescription}>{t('inbox.emptyDescription')}</Text>
                    </View>
                )}

                {body === 'content' && openApprovals.length > 0 && (
                    <ItemGroup title={t('inbox.approvals')}>
                        {openApprovals.map((artifact) => (
                            <ApprovalInboxCard
                                key={artifact.id}
                                artifact={artifact}
                                onPress={() => router.push(`/inbox/approvals/${artifact.id}`)}
                            />
                        ))}
                    </ItemGroup>
                )}

                {body === 'content' && sessionsNeedingAttention.map((entry) => (
                    <ItemGroup key={entry.session.id} title={getSessionName(entry.session)}>
                        <InboxSessionAttentionGroupCard
                            session={entry.session}
                            permissionRequests={entry.pendingPermissions}
                            userActionRequests={entry.pendingUserActions}
                        />
                    </ItemGroup>
                ))}

                {body === 'content' && unreadSessions.length > 0 && (
                    <ItemGroup title={t('inbox.unreadSessions')}>
                        {unreadSessions.map((row) => (
                            <Item
                                key={`${row.serverId ?? 'local'}:${row.session.id}`}
                                title={getSessionName(row.session)}
                                subtitle={getSessionSubtitle(row.session)}
                                onPress={() => router.push(createActivitySurfaceSessionRoute(row.session.id, row.serverId))}
                            />
                        ))}
                    </ItemGroup>
                )}

                {body === 'content' && showFriendsActivity && friendRequests.length > 0 && (
                    <ItemGroup title={t('friends.pendingRequests')}>
                        {friendRequests.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => {
                                    trackFriendsProfileView();
                                    router.push(`/user/${friend.id}`);
                                }}
                            />
                        ))}
                    </ItemGroup>
                )}

                {body === 'content' && showFriendsActivity && requestedFriends.length > 0 && (
                    <ItemGroup title={t('friends.requestPending')}>
                        {requestedFriends.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => {
                                    trackFriendsProfileView();
                                    router.push(`/user/${friend.id}`);
                                }}
                            />
                        ))}
                    </ItemGroup>
                )}

                {body === 'content' && showFriendsActivity && feedItems.length > 0 && (
                    <ItemGroup title={t('inbox.updates')}>
                        {feedItems.map((item) => (
                            <FeedItemCard key={item.id} item={item} />
                        ))}
                    </ItemGroup>
                )}
            </ScrollView>
        </View>
    );
});
