import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { getUserProfile } from '@/sync/api/social/apiFriends';
import { readFriendMutationProfile } from '@/sync/ops/friends';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { UserProfile } from '@/sync/domains/social/friendTypes';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import { trackFriendsConnect } from '@/track';
import { useAllSessions } from '@/sync/domains/state/storage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { HappyError } from '@/utils/errors/errors';
import { getAuthProvider } from '@/auth/providers/registry';
import { isSafeBadgeUrl } from '@/utils/url/urlSafety';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { Icon } from '@/components/ui/icons/Icon';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

const USERNAME_PREFIX = '@';

export default function UserProfileScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { credentials } = useAuth();
    const { serverId } = useActiveServerSnapshot();
    const { execute } = useMountedActionExecution(serverId);
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const { theme } = useUnistyles();
    const sessions = useAllSessions();
    const isSessionVisible = useSessionRecordingVisibility();
    // This route is explicitly an active-Home social surface, so the runtime-
    // scoped decision is the exact one; a Session-qualified target is not known here.
    const sharingSupported = useFeatureEnabled('sharing.session');
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // Load user profile on mount
    useEffect(() => {
        if (!credentials || !id) return;

        const loadUserProfile = async () => {
            setIsLoading(true);
            try {
                const profile = await getUserProfile(credentials, id);
                setUserProfile(profile);
            } catch (error) {
                console.error('Failed to load user profile:', error);
                await Modal.alert(t('errors.failedToLoadProfile'), '', [
                    {
                        text: t('common.ok'),
                        onPress: () => router.back()
                    }
                ]);
            } finally {
                setIsLoading(false);
            }
        };

        loadUserProfile();
    }, [credentials, id]);

    // Add friend / Accept request action
    const [addingFriend, addFriend] = useHappyAction(async () => {
        if (!credentials || !userProfile) return;

        try {
            const updatedProfile = readFriendMutationProfile(
                await execute('friends.add', { uid: userProfile.id }),
            );
            if (updatedProfile) {
                trackFriendsConnect();
                setUserProfile(updatedProfile);
            } else {
                await Modal.alert(t('friends.userNotFound'));
            }
        } catch (e) {
            if (e instanceof HappyError && e.message === 'provider-required') {
                await Modal.alert(t('friends.bothMustHaveGithub'));
                return;
            }
            if (e instanceof HappyError && e.message === 'username-required') {
                await Modal.alert(t('friends.username.required'));
                return;
            }
            if (e instanceof HappyError && e.message === 'friends-disabled') {
                await Modal.alert(t('friends.disabled'));
                return;
            }
            throw e;
        }
    });

    // Remove friend / Cancel request / Reject request action  
    const [removingFriend, handleRemoveFriend] = useHappyAction(async () => {
        if (!credentials || !userProfile) return;

        const updatedProfile = readFriendMutationProfile(
            await execute('friends.remove', { uid: userProfile.id }),
        );
        if (updatedProfile) {
            setUserProfile(updatedProfile);
        }
    });

    if (isLoading || !userProfile) {
        // The page keeps its identity while the person loads or when they can't be found: the same
        // header with a placeholder name, then the state where the sections would be.
        return (
            <ItemList>
                <PageHeader
                    testID="user-profile.header"
                    alwaysShowTitle
                    title={t('detailPages.person.placeholderTitle')}
                    leading={<Avatar id={id ?? ''} size={48} />}
                />
                <ItemGroup surface="none">
                    {isLoading ? (
                        <SurfaceStateCard testID="user-profile.loading" kind="loading" title={t('common.loading')} />
                    ) : (
                        <SurfaceStateCard testID="user-profile.not-found" kind="unavailable" title={t('errors.userNotFound')} />
                    )}
                </ItemGroup>
            </ItemList>
        );
    }

    const displayName = formatAccountDisplayName(userProfile) ?? t('accountDisplay.unnamed');
    const avatarUrl = userProfile.avatar?.url;

    // What the viewer can do about this friendship. The one forward action is primary; declining or
    // withdrawing is quiet, and removing an existing friend closes the page as a destructive action.
    const friendActions: ReadonlyArray<{
        key: string;
        title: string;
        display: 'default' | 'secondary';
        onPress: () => void;
        loading: boolean;
    }> = (() => {
        switch (userProfile.status) {
            case 'friend':
                return [];
            case 'pending':
                // User has received a friend request
                return [
                    { key: 'accept', title: t('friends.acceptRequest'), display: 'default' as const, onPress: addFriend, loading: addingFriend },
                    { key: 'deny', title: t('friends.denyRequest'), display: 'secondary' as const, onPress: handleRemoveFriend, loading: removingFriend },
                ];
            case 'requested':
                // User has sent a friend request
                return [
                    { key: 'cancel', title: t('friends.cancelRequest'), display: 'secondary' as const, onPress: handleRemoveFriend, loading: removingFriend },
                ];
            case 'rejected':
            case 'none':
            default:
                return [
                    { key: 'request', title: t('friends.requestFriendship'), display: 'default' as const, onPress: addFriend, loading: addingFriend },
                ];
        }
    })();

    const sharedSessions = userProfile.status === 'friend' && sharingSupported
        ? sessions.filter(session => session.owner === userProfile.id && typeof session.serverId === 'string'
            && isSessionVisible({ sessionId: session.id, serverId: session.serverId }))
        : [];

    const headerFacts: PageHeaderMetaFact[] = [
        { key: 'username', text: `${USERNAME_PREFIX}${userProfile.username}` },
        ...(userProfile.status === 'friend'
            ? [{ key: 'friends', text: t('friends.alreadyFriends'), icon: 'check-circle' as const }]
            : []),
    ];

    return (
        <ItemList>
            <PageHeader
                testID="user-profile.header"
                alwaysShowTitle
                title={displayName}
                description={userProfile.bio || undefined}
                meta={headerFacts}
                leading={(
                    <Avatar
                        id={userProfile.id}
                        size={48}
                        imageUrl={avatarUrl}
                        thumbhash={userProfile.avatar?.thumbhash}
                    />
                )}
                actions={friendActions.length > 0 ? (
                    <View style={styles.headerActions}>
                        {friendActions.map((action) => (
                            <RoundButton
                                key={action.key}
                                testID={`user-profile.friendship.${action.key}`}
                                size="normal"
                                display={action.display}
                                title={action.title}
                                accessibilityLabel={action.title}
                                loading={action.loading}
                                onPress={action.onPress}
                            />
                        ))}
                    </View>
                ) : undefined}
            />

            {/* Sessions shared by this friend */}
            {userProfile.status === 'friend' && sharingSupported && (
                <ItemGroup
                    title={t('friends.sharedSessions')}
                    description={t('detailPages.person.sharedSessionsDescription')}
                >
                    {sharedSessions.length > 0 ? (
                        sharedSessions.map((session) => {
                            const serverId = session.serverId;
                            if (typeof serverId !== 'string') return null;
                            return (
                                <Item
                                    key={sessionAddressKey({ serverId, sessionId: session.id })}
                                    title={getSessionName(session)}
                                    icon={<Icon name="chat-circle-dots" />}
                                    subtitle={t('session.sharing.viewOnly')}
                                    onPress={() => void navigateToSession(session.id, { serverId })}
                                />
                            );
                        })
                    ) : (
                        <Item
                            title={t('friends.noSharedSessions')}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            )}

            {userProfile.badges?.length ? (
                <ItemGroup
                    title={t('detailPages.person.linkedAccountsTitle')}
                    description={t('detailPages.person.linkedAccountsDescription')}
                >
                    {userProfile.badges.map((badge) => {
                        const provider = getAuthProvider(badge.id);
                        const iconName = provider?.badgeIconName ?? 'link-outline';
                        const title = provider?.displayName ?? badge.id;
                        return (
                            <Item
                                key={`${badge.id}:${badge.url}`}
                                title={title}
                                detail={badge.label}
                                icon={<Icon name={iconName as any} size={29} color={theme.colors.text.primary} />}
                                onPress={async () => {
                                    try {
                                        if (!isSafeBadgeUrl(badge.url)) {
                                            await Modal.alert(t('common.error'), t('errors.invalidShareLink'));
                                            return;
                                        }
                                        if (!await requestOpenExternalUrl(badge.url, { serverId })) {
                                            await Modal.alert(t('common.error'), t('errors.invalidShareLink'));
                                        }
                                    } catch {
                                        await Modal.alert(t('common.error'), t('errors.invalidShareLink'));
                                    }
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}

            {userProfile.status === 'friend' ? (
                <ItemGroup surface="none">
                    <View style={styles.closingActions}>
                        <RoundButton
                            testID="user-profile.friendship.remove"
                            size="normal"
                            display="destructive"
                            title={t('friends.removeFriend')}
                            accessibilityLabel={t('friends.removeFriend')}
                            loading={removingFriend}
                            onPress={handleRemoveFriend}
                        />
                    </View>
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    closingActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
}));
