import * as React from 'react';
import { View } from 'react-native';
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
import { trackFriendsProfileView } from '@/track';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { FeedItemCard } from '@/components/inbox/cards/FeedItemCard';
import { RequireFriendsIdentityForFriends } from '@/components/friends/RequireFriendsIdentityForFriends';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useFriendsAddAction } from '@/hooks/friends/useFriendsAddAction';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { TeamPeopleSections } from '@/components/settings/teams/members/TeamPeopleSections';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';

/**
 * People: the friends and teammates you work and share with, on one page (owner ruling Q6).
 * Friends come from the friends store and its identity gate; teammates come from the Teams
 * directory and roster owners, whose Members pages keep roles, encryption and membership changes.
 * The page header owns the title and Add friend; a host that already draws both in its own bar (the
 * phone tab shell) passes `header="none"`.
 */
export const FriendsView = React.memo(function FriendsView(props: Readonly<{ header?: 'page' | 'none' }>) {
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
    const feedLoaded = useFeedLoaded();
    const friendsLoaded = useFriendsLoaded();
    const friendsIdentityReady = useFriendsIdentityReadiness().isReady;
    const { openSearch } = useFriendsAddAction();
    const myId = syncStorage((state) => state.profile.id);
    const sessions = useAllSessions();
    const isSessionVisible = useSessionRecordingVisibility();

    const sharedSessions = React.useMemo(() => {
        if (!myId) return [];
        return sessions.filter((s) => s.owner && s.owner !== myId
            && isSessionVisible({ sessionId: s.id, serverId: s.serverId }));
    }, [sessions, myId, isSessionVisible]);

    const openProfile = React.useCallback((id: string) => {
        trackFriendsProfileView();
        router.push(`/user/${id}`);
    }, [router]);

    const phoneBack = usePhoneDestinationBack('people:back');
    const inheritedBack = useNavigationBackControl();
    const friendsLoading = !friendsLoaded;
    const noFriendsYet = friendsLoaded && friends.length === 0 && friendRequests.length === 0 && requestedFriends.length === 0;

    return (
        <ItemList testID="people-page">
            {props.header !== 'none' ? (
                <NavigationBackChromeProvider control={phoneBack ?? inheritedBack}>
                    <PageHeader
                        title={t('tabs.friends')}
                        description={t('friends.peopleDescription')}
                        primaryAction={friendsIdentityReady ? {
                            title: t('friends.addFriend'),
                            icon: 'user-plus',
                            onPress: openSearch,
                            testID: 'friends-add-friend',
                        } : undefined}
                    />
                </NavigationBackChromeProvider>
            ) : null}

            {!friendsIdentityReady ? (
                <ItemGroup title={t('friends.title')}>
                    <RequireFriendsIdentityForFriends>
                        <View />
                    </RequireFriendsIdentityForFriends>
                </ItemGroup>
            ) : (
                <>
                    {friendRequests.length > 0 && (
                        <ItemGroup title={t('friends.pendingRequests')}>
                            {friendRequests.map((friend) => (
                                <UserCard key={friend.id} user={friend} onPress={() => openProfile(friend.id)} />
                            ))}
                        </ItemGroup>
                    )}

                    <ItemGroup title={t('friends.title')}>
                        {friendsLoading ? (
                            <SurfaceStateCard testID="people-friends-loading" kind="loading" size="line" title={t('common.loading')} />
                        ) : noFriendsYet ? (
                            <EmptyState
                                testID="people-friends-empty"
                                layout="line"
                                title={t('friends.emptyDescription')}
                                primaryAction={{ label: t('friends.addFriend'), onPress: openSearch }}
                            />
                        ) : friends.map((friend) => (
                            <UserCard key={friend.id} user={friend} onPress={() => openProfile(friend.id)} />
                        ))}
                    </ItemGroup>

                    {requestedFriends.length > 0 && (
                        <ItemGroup title={t('friends.requestPending')}>
                            {requestedFriends.map((friend) => (
                                <UserCard key={friend.id} user={friend} onPress={() => openProfile(friend.id)} />
                            ))}
                        </ItemGroup>
                    )}
                </>
            )}

            <TeamPeopleSections />

            {sharedSessions.length > 0 && (
                <ItemGroup title={t('friends.sharedSessions')}>
                    {sharedSessions.map((session) => {
                        const title = getSessionName(session, session.serverId);
                        // A Session row may predate its Home binding; the id alone still
                        // identifies it, and a bound one keeps the Home-qualified key.
                        const address = normalizeSessionAddress(session.serverId, session.id);
                        const subtitle = session.ownerProfile?.username ? `@${session.ownerProfile.username}` : undefined;
                        return (
                            <Item
                                key={address ? sessionAddressKey(address) : session.id}
                                title={title}
                                subtitle={subtitle}
                                onPress={() => void navigateToSession(session.id, { serverId: session.serverId })}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {feedLoaded && feedItems.length > 0 && (
                <ItemGroup title={t('friends.activity')}>
                    {feedItems.map((item) => (
                        <FeedItemCard key={item.id} item={item} />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
});
