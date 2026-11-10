import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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
import { matchesPeopleQuery } from '@/components/friends/peopleQuery';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { UserProfile } from '@/sync/domains/social/friendTypes';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useFriendsAddAction } from '@/hooks/friends/useFriendsAddAction';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { PhonePageBackLine, usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { TeamPeopleSections } from '@/components/settings/teams/members/TeamPeopleSections';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { CollectionCreateButton, CollectionSearchToggle } from '@/components/ui/lists/collection/CollectionList';
import { usePublishPageCreateAction, type PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { useDeviceType } from '@/utils/platform/responsive';

/** A friend answers the page's search by their display name or username. */
function personMatches(query: string, user: UserProfile): boolean {
    return matchesPeopleQuery(query, formatAccountDisplayName(user), user.username);
}

/**
 * People: the friends and teammates you work and share with, on one page (owner ruling Q6). A main screen: its title
 * row carries the search (it narrows every person on the page) and "+" (add people, the add-friend flow), which a
 * phone also lends to the bar beside the tabs. Friends come from the friends store and its identity gate, whose
 * section claims the username first; teammates come from the Teams directory and roster owners, whose Members pages
 * keep roles, encryption and membership changes.
 */
export const FriendsView = React.memo(function FriendsView() {
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
    const phone = useDeviceType() === 'phone';
    const [query, setQuery] = React.useState('');
    const [searchOpened, setSearchOpened] = React.useState(false);
    // A query keeps the field open; closing it clears the query (the collection's collapsible search).
    const searchOpen = searchOpened || query.length > 0;
    const toggleSearch = React.useCallback(() => {
        if (searchOpen) {
            setQuery('');
            setSearchOpened(false);
        } else {
            setSearchOpened(true);
        }
    }, [searchOpen]);
    const searching = query.trim().length > 0;

    const sharedSessions = React.useMemo(() => {
        if (!myId) return [];
        return sessions.filter((s) => s.owner && s.owner !== myId
            && isSessionVisible({ sessionId: s.id, serverId: s.serverId })
            && matchesPeopleQuery(query, getSessionName(s, s.serverId), s.ownerProfile?.username));
    }, [sessions, myId, isSessionVisible, query]);
    const shownRequests = React.useMemo(() => friendRequests.filter((user) => personMatches(query, user)), [friendRequests, query]);
    const shownFriends = React.useMemo(() => friends.filter((user) => personMatches(query, user)), [friends, query]);
    const shownRequested = React.useMemo(() => requestedFriends.filter((user) => personMatches(query, user)), [requestedFriends, query]);

    const openProfile = React.useCallback((id: string) => {
        trackFriendsProfileView();
        router.push(`/user/${id}`);
    }, [router]);

    // A phone decides its Back once (none on this main screen, one on a page it is pushed as); wider hosts keep theirs.
    const phoneBack = usePhoneDestinationBack('people:back');
    const inheritedBack = useNavigationBackControl();
    const create = React.useMemo<PageCreateAction | null>(() => friendsIdentityReady ? {
        label: t('friends.addFriend'),
        testID: 'friends-add-friend',
        onPress: openSearch,
    } : null, [friendsIdentityReady, openSearch]);
    usePublishPageCreateAction(phone ? create : null);
    const friendsLoading = !friendsLoaded;
    const noFriendsYet = friendsLoaded && friends.length === 0 && friendRequests.length === 0 && requestedFriends.length === 0;

    return (
        <View style={styles.page}>
        {/* The phone page's head line under the status bar, as on every main screen: its title shares their line,
            and a page that pushes People carries its Back there. */}
        <PhonePageBackLine control={phoneBack} page />
        <ItemList testID="people-page">
            <NavigationBackChromeProvider control={phone ? null : inheritedBack}>
                <PageHeader
                    title={t('tabs.friends')}
                    description={t('friends.peopleDescription')}
                    actionsPlacement="page"
                    actionsLayout="inline"
                    actions={(
                        <>
                            <CollectionSearchToggle
                                testID="people-search-toggle"
                                open={searchOpen}
                                onPress={toggleSearch}
                                accessibilityLabel={t('friends.peopleSearchPlaceholder')}
                            />
                            {create ? <CollectionCreateButton create={create} /> : null}
                        </>
                    )}
                />
            </NavigationBackChromeProvider>
            {searchOpen ? (
                <CompactSearchField
                    testID="people-search"
                    placement="page"
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('friends.peopleSearchPlaceholder')}
                    autoFocus={searchOpened && query.length === 0}
                />
            ) : null}

            <RequireFriendsIdentityForFriends>
                {shownRequests.length > 0 && (
                    <ItemGroup title={t('friends.pendingRequests')}>
                        {shownRequests.map((friend) => (
                            <UserCard key={friend.id} user={friend} onPress={() => openProfile(friend.id)} />
                        ))}
                    </ItemGroup>
                )}

                {searching ? (
                    shownFriends.length > 0 ? (
                        <ItemGroup title={t('friends.title')}>
                            {shownFriends.map((friend) => (
                                <UserCard key={friend.id} user={friend} onPress={() => openProfile(friend.id)} />
                            ))}
                        </ItemGroup>
                    ) : null
                ) : (
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
                        ) : shownFriends.map((friend) => (
                            <UserCard key={friend.id} user={friend} onPress={() => openProfile(friend.id)} />
                        ))}
                    </ItemGroup>
                )}

                {shownRequested.length > 0 && (
                    <ItemGroup title={t('friends.requestPending')}>
                        {shownRequested.map((friend) => (
                            <UserCard key={friend.id} user={friend} onPress={() => openProfile(friend.id)} />
                        ))}
                    </ItemGroup>
                )}
            </RequireFriendsIdentityForFriends>

            <TeamPeopleSections query={query} />

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

            {!searching && feedLoaded && feedItems.length > 0 && (
                <ItemGroup title={t('friends.activity')}>
                    {feedItems.map((item) => (
                        <FeedItemCard key={item.id} item={item} />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
        </View>
    );
});

const styles = StyleSheet.create({
    page: { flex: 1, minHeight: 0 },
});
