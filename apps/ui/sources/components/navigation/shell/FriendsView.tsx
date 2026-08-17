import * as React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    useAcceptedFriends,
    useAllSessions,
    useFeedItems,
    useFeedLoaded,
    useFriendRequests,
    useFriendsLoaded,
    useRequestedFriends,
} from '@/sync/domains/state/storage';
import { storage as syncStorage } from '@/sync/domains/state/storageStore';
import { UserCard } from '@/components/ui/cards/UserCard';
import { t } from '@/text';
import { trackFriendsProfileView, trackFriendsSearch } from '@/track';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { useIsTablet } from '@/utils/platform/responsive';
import { Header } from '@/components/navigation/Header';
import { Image } from 'expo-image';
import { FeedItemCard } from '@/components/inbox/cards/FeedItemCard';
import { RequireFriendsIdentityForFriends } from '@/components/friends/RequireFriendsIdentityForFriends';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { Icon } from '@/components/ui/icons/Icon';

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

interface FriendsViewProps {}

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
            {t('tabs.friends')}
        </Text>
    );
}

function HeaderRightTablet() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;

    if (!friendsIdentityReady) {
        return <View style={{ width: 32, height: 32 }} />;
    }

    return (
        <Pressable
            onPress={() => {
                trackFriendsSearch();
                router.push('/friends/search');
            }}
            hitSlop={15}
            style={{
                width: 32,
                height: 32,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Icon name="user-plus" size={24} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
}

export const FriendsView = React.memo(({}: FriendsViewProps) => {
    const router = useRouter();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
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
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const myId = syncStorage((state) => state.profile.id);
    const sessions = useAllSessions();

    const sharedSessions = React.useMemo(() => {
        if (!myId) return [];
        return sessions.filter((s) => s.owner && s.owner !== myId);
    }, [sessions, myId]);

    const isLoading = !feedLoaded || !friendsLoaded;
    const isEmpty = !isLoading &&
        friendRequests.length === 0 &&
        requestedFriends.length === 0 &&
        friends.length === 0 &&
        sharedSessions.length === 0 &&
        feedItems.length === 0;

    if (!friendsIdentityReady) {
        return (
            <View style={styles.container}>
                {isTablet && (
                    <View style={{ backgroundColor: theme.colors.background.canvas }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerRight={() => <HeaderRightTablet />}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                    </View>
                )}
                <RequireFriendsIdentityForFriends>
                    <View />
                </RequireFriendsIdentityForFriends>
            </View>
        );
    }

    // `isLoading` and `isEmpty` are transient — friends activity flips between
    // them while the surface is open (a request arrives, the last item is
    // cleared). They may only change what renders inside the scroll container,
    // never whether it is mounted, so the ScrollView keeps identity and offset.
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
                        headerRight={() => <HeaderRightTablet />}
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
                        <Text style={styles.emptyTitle}>{t('friends.emptyTitle')}</Text>
                        <Text style={styles.emptyDescription}>{t('friends.emptyDescription')}</Text>
                    </View>
                )}

                {body === 'content' && friendRequests.length > 0 && (
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

                {body === 'content' && requestedFriends.length > 0 && (
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

                {body === 'content' && sharedSessions.length > 0 && (
                    <ItemGroup title={t('friends.sharedSessions')}>
                        {sharedSessions.map((session) => {
                            const title = getSessionName(session);
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

                {body === 'content' && feedItems.length > 0 && (
                    <ItemGroup title={t('friends.activity')}>
                        {feedItems.map((item) => (
                            <FeedItemCard key={item.id} item={item} />
                        ))}
                    </ItemGroup>
                )}

                {body === 'content' && friends.length > 0 && (
                    <ItemGroup title={t('friends.myFriends')}>
                        {friends.map((friend) => (
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
            </ScrollView>
        </View>
    );
});
