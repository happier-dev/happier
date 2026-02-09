import React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useAcceptedFriends, useFriendRequests, useRequestedFriends } from '@/sync/domains/state/storage';
import { UserCard } from '@/components/ui/cards/UserCard';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useRouter } from 'expo-router';
import { useRequireInboxFriendsEnabled } from '@/hooks/inbox/useRequireInboxFriendsEnabled';
import { RequireFriendsIdentityForFriends } from '@/components/friends/RequireFriendsIdentityForFriends';

export default function FriendsManageScreen() {
    const enabled = useRequireInboxFriendsEnabled();
    const router = useRouter();
    const friends = useAcceptedFriends();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();

    if (!enabled) return null;

    return (
        <RequireFriendsIdentityForFriends>
            <ItemList style={{ paddingTop: 0 }}>
                {/* Friend Requests Section */}
                {friendRequests.length > 0 && (
                    <ItemGroup
                        title={t('friends.pendingRequests')}
                        style={styles.groupStyle}
                    >
                        {friendRequests.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => router.push(`/user/${friend.id}`)}
                            />
                        ))}
                    </ItemGroup>
                )}

                {/* Sent Requests Section */}
                {requestedFriends.length > 0 && (
                    <ItemGroup
                        title={t('friends.requestPending')}
                        style={styles.groupStyle}
                    >
                        {requestedFriends.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => router.push(`/user/${friend.id}`)}
                            />
                        ))}
                    </ItemGroup>
                )}

                {/* Friends List Section */}
                <ItemGroup
                    title={t('friends.myFriends')}
                    style={styles.groupStyle}
                >
                    {friends.length === 0 ? (
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyText}>
                                {t('friends.noFriendsYet')}
                            </Text>
                        </View>
                    ) : (
                        friends.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => router.push(`/user/${friend.id}`)}
                            />
                        ))
                    )}
                </ItemGroup>
            </ItemList>
        </RequireFriendsIdentityForFriends>
    );
}

const styles = StyleSheet.create((theme) => ({
    groupStyle: {
        marginBottom: 16,
    },
    emptyState: {
        alignItems: 'center',
        padding: 32,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));
