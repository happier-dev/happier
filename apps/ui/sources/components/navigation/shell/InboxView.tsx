import * as React from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    useAllSessions,
    useArtifacts,
    useFeedItems,
    useFeedLoaded,
    useFriendRequests,
    useFriendsLoaded,
    useRequestedFriends,
} from '@/sync/domains/state/storage';
import { storage as syncStorage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { layout } from '@/components/ui/layout/layout';
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
import { InboxSessionAttentionGroupCard } from '@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard';
import { listPendingPermissionRequests, listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
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
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyDescription: {
        fontSize: 16,
        ...Typography.default(),
        color: theme.colors.textSecondary,
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
            color: theme.colors.header.tint,
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
    const friendsEnabled = useFriendsEnabled();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const myId = syncStorage((state) => state.profile.id);
    const sessions = useAllSessions();

    const openApprovals = React.useMemo(() => {
        return artifacts.filter((a) => a.header?.kind === 'approval_request.v1' && a.header?.approvalStatus === 'open');
    }, [artifacts]);

    const sessionsNeedingAttention = React.useMemo(() => {
        return sessions.flatMap((s) => {
            if (s.presence !== 'online') return [];
            const pendingPermissions = listPendingPermissionRequests(s);
            const pendingUserActions = listPendingUserActionRequests(s);
            if (pendingPermissions.length === 0 && pendingUserActions.length === 0) return [];
            return [{ session: s, pendingPermissions, pendingUserActions }];
        });
    }, [sessions]);

    const sharedSessions = React.useMemo(() => {
        if (!myId) return [];
        return sessions.filter((s) => s.owner && s.owner !== myId);
    }, [sessions, myId]);

    const showFriendsActivity = friendsEnabled && friendsIdentityReady;

    const isLoading = friendsEnabled ? (!feedLoaded || !friendsLoaded) : false;
    const isEmpty = !isLoading &&
        openApprovals.length === 0 &&
        sessionsNeedingAttention.length === 0 &&
        sharedSessions.length === 0 &&
        (!showFriendsActivity || (
            friendRequests.length === 0 &&
            requestedFriends.length === 0 &&
            feedItems.length === 0
        ));

    if (isLoading) {
        return (
            <View style={styles.container}>
                {isTablet && (
                    <View style={{ backgroundColor: theme.colors.groupped.background }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerRight={() => null}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                    </View>
                )}
                <RecoveryKeyReminderBanner />
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                </View>
            </View>
        );
    }

    if (isEmpty) {
        return (
            <View style={styles.container}>
                {isTablet && (
                    <View style={{ backgroundColor: theme.colors.groupped.background }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerRight={() => null}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                    </View>
                )}
                <RecoveryKeyReminderBanner />
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <Image
                        source={require('@/assets/images/brutalist/Brutalism 10.png')}
                        contentFit="contain"
                        style={[{ width: 64, height: 64 }, styles.emptyIcon]}
                        tintColor={theme.colors.textSecondary}
                    />
                    <Text style={styles.emptyTitle}>{t('inbox.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('inbox.emptyDescription')}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {isTablet && (
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
                    <Header
                        title={<HeaderTitleTablet />}
                        headerRight={() => null}
                        headerLeft={() => null}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                </View>
            )}
            <ScrollView contentContainerStyle={{
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                width: '100%'
            }}>
                <RecoveryKeyReminderBanner />
                <UpdateBanner />

                {openApprovals.length > 0 && (
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

                {sessionsNeedingAttention.length > 0 && (
                    <ItemGroup title={t('inbox.permissions')}>
                        {sessionsNeedingAttention.map((entry) => {
                            return (
                                <InboxSessionAttentionGroupCard
                                    key={entry.session.id}
                                    session={entry.session}
                                    permissionRequests={entry.pendingPermissions}
                                    userActionRequests={entry.pendingUserActions}
                                />
                            );
                        })}
                    </ItemGroup>
                )}

                {showFriendsActivity && friendRequests.length > 0 && (
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

                {showFriendsActivity && requestedFriends.length > 0 && (
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

                {sharedSessions.length > 0 && (
                    <ItemGroup title={t('friends.sharedSessions')}>
                        {sharedSessions.map((session) => {
                            const title = session.metadata?.name || session.metadata?.path || session.id;
                            const subtitle = session.ownerProfile?.username ? `@${session.ownerProfile.username}` : undefined;
                            return (
                                <Item
                                    key={session.id}
                                    title={title}
                                    subtitle={subtitle}
                                    onPress={() => router.push(`/session/${session.id}`)}
                                />
                            );
                        })}
                    </ItemGroup>
                )}

                {showFriendsActivity && feedItems.length > 0 && (
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
