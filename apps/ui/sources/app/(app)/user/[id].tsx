import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/text/StyledText';
import { useAuth } from '@/auth/context/AuthContext';
import { getUserProfile, sendFriendRequest, removeFriend } from '@/sync/api/social/apiFriends';
import { UserProfile, getDisplayName } from '@/sync/domains/social/friendTypes';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import { trackFriendsConnect } from '@/track';
import { Ionicons } from '@expo/vector-icons';
import { useAllSessions } from '@/sync/domains/state/storage';
import { useSessionSharingSupport } from '@/hooks/session/useSessionSharingSupport';
import { HappyError } from '@/utils/errors/errors';
import { getAuthProvider } from '@/auth/providers/registry';
import { isSafeBadgeUrl } from '@/utils/url/urlSafety';

export default function UserProfileScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { credentials } = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const sessions = useAllSessions();
    const sharingSupported = useSessionSharingSupport();
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
            const updatedProfile = await sendFriendRequest(credentials, userProfile.id);
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

        if (userProfile.status === 'friend') {
            // Removing a friend
            const confirmed = await Modal.confirm(
                t('friends.removeFriend'),
                t('friends.removeFriendConfirm', { name: getDisplayName(userProfile) }),
                { confirmText: t('friends.remove'), destructive: true }
            );

            if (!confirmed) return;
        } else if (userProfile.status === 'requested') {
            // Canceling a sent request
            const confirmed = await Modal.confirm(
                t('friends.cancelRequest'),
                t('friends.cancelRequestConfirm', { name: getDisplayName(userProfile) }),
                { confirmText: t('common.yes'), destructive: false }
            );

            if (!confirmed) return;
        }

        const updatedProfile = await removeFriend(credentials, userProfile.id);
        if (updatedProfile) {
            setUserProfile(updatedProfile);
        }
    });

    if (isLoading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
            </View>
        );
    }

    if (!userProfile) {
        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{t('errors.userNotFound')}</Text>
            </View>
        );
    }

    const displayName = getDisplayName(userProfile);
    const avatarUrl = userProfile.avatar?.url;

    // Determine friend actions based on status
    const getFriendActions = () => {
        switch (userProfile.status) {
            case 'friend':
                return [{
                    title: t('friends.removeFriend'),
                    icon: <Ionicons name="person-remove-outline" size={29} color="#FF3B30" />,
                    onPress: handleRemoveFriend,
                    loading: removingFriend,
                }];
            case 'pending':
                // User has received a friend request
                return [
                    {
                        title: t('friends.acceptRequest'),
                        icon: <Ionicons name="checkmark-circle-outline" size={29} color="#34C759" />,
                        onPress: addFriend,
                        loading: addingFriend,
                    },
                    {
                        title: t('friends.denyRequest'),
                        icon: <Ionicons name="close-circle-outline" size={29} color="#FF3B30" />,
                        onPress: handleRemoveFriend,
                        loading: removingFriend,
                    }
                ];
            case 'requested':
                // User has sent a friend request
                return [{
                    title: t('friends.cancelRequest'),
                    icon: <Ionicons name="close-outline" size={29} color="#FF9500" />,
                    onPress: handleRemoveFriend,
                    loading: removingFriend,
                }];
            case 'rejected':
            case 'none':
            default:
                return [{
                    title: t('friends.requestFriendship'),
                    icon: <Ionicons name="person-add-outline" size={29} color="#007AFF" />,
                    onPress: addFriend,
                    loading: addingFriend,
                }];
        }
    };

    const friendActions = getFriendActions();
    const sharedSessions = userProfile.status === 'friend' && sharingSupported
        ? sessions.filter(session => session.owner === userProfile.id)
        : [];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* User Info Header */}
            <View style={styles.headerContainer}>
                <View style={styles.profileCard}>
                    <View style={{ marginBottom: 16 }}>
                        <Avatar
                            id={userProfile.id}
                            size={90}
                            imageUrl={avatarUrl}
                            thumbhash={userProfile.avatar?.thumbhash}
                        />
                    </View>

                    <Text style={styles.displayName}>{displayName}</Text>

                    <Text style={styles.username}>@{userProfile.username}</Text>

                    {/* Bio */}
                    {userProfile.bio && (
                        <Text style={styles.bio}>{userProfile.bio}</Text>
                    )}

                    {/* Friend Status Badge */}
                    {userProfile.status === 'friend' && (
                        <View style={styles.statusBadge}>
                            <Ionicons name="checkmark-circle" size={16} color="#34C759" />
                            <Text style={styles.statusText}>{t('friends.alreadyFriends')}</Text>
                        </View>
                    )}
                </View>
            </View>

            {/* Actions */}
            <ItemGroup>
                {friendActions.map((action, index) => (
                    <Item
                        key={index}
                        title={action.title}
                        icon={action.icon}
                        onPress={action.onPress}
                        loading={action.loading}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {/* Sessions shared by this friend */}
            {userProfile.status === 'friend' && sharingSupported && (
                <ItemGroup title={t('friends.sharedSessions')}>
                    {sharedSessions.length > 0 ? (
                        sharedSessions.map((session) => (
                            <Item
                                key={session.id}
                                title={session.metadata?.name || session.metadata?.path || t('sessionHistory.title')}
                                subtitle={t('session.sharing.viewOnly')}
                                icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color="#007AFF" />}
                                onPress={() => router.push(`/session/${session.id}`)}
                            />
                        ))
                    ) : (
                        <Item
                            title={t('friends.noSharedSessions')}
                            icon={<Ionicons name="chatbubble-outline" size={29} color={theme.colors.textSecondary} />}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            )}

            {userProfile.badges?.length ? (
                <ItemGroup>
                    {userProfile.badges.map((badge) => {
                        const provider = getAuthProvider(badge.id);
                        const iconName = provider?.badgeIconName ?? 'link-outline';
                        const title = provider?.displayName ?? badge.id;
                        return (
                            <Item
                                key={`${badge.id}:${badge.url}`}
                                title={title}
                                detail={badge.label}
                                icon={<Ionicons name={iconName as any} size={29} color={theme.colors.text} />}
                                onPress={async () => {
                                    try {
                                        if (!isSafeBadgeUrl(badge.url)) {
                                            await Modal.alert(t('common.error'), t('errors.invalidShareLink'));
                                            return;
                                        }
                                        const supported = await Linking.canOpenURL(badge.url);
                                        if (!supported) {
                                            await Modal.alert(t('common.error'), t('errors.invalidShareLink'));
                                            return;
                                        }
                                        await Linking.openURL(badge.url);
                                    } catch {
                                        await Modal.alert(t('common.error'), t('errors.invalidShareLink'));
                                    }
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}

            {/* Profile Details */}
            {/* <ItemGroup>
                <Item
                    title={t('profile.firstName')}
                    detail={userProfile.firstName || '-'}
                    showChevron={false}
                />
                <Item
                    title={t('profile.lastName')}
                    detail={userProfile.lastName || '-'}
                    showChevron={false}
                />
                <Item
                    title={t('profile.username')}
                    detail={`@${userProfile.username}`}
                    showChevron={false}
                />
                <Item
                    title={t('profile.status')}
                    detail={t(`friends.status.${userProfile.status}`)}
                    showChevron={false}
                />
            </ItemGroup> */}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.groupped.background,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.groupped.background,
        padding: 32,
    },
    errorText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    headerContainer: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    profileCard: {
        alignItems: 'center',
        paddingVertical: 32,
        backgroundColor: theme.colors.surface,
        marginTop: 16,
        borderRadius: 12,
        marginHorizontal: 16,
    },
    displayName: {
        fontSize: 24,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 4,
    },
    username: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
    bio: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        paddingHorizontal: 32,
        marginBottom: 16,
    },
    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(52, 199, 89, 0.1)',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        marginTop: 8,
    },
    statusText: {
        fontSize: 13,
        color: '#34C759',
        marginLeft: 4,
        fontWeight: '500',
    },
}));
