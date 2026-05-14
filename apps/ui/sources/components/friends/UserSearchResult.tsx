import React from 'react';
import { View, TouchableOpacity, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { UserProfile, getDisplayName } from '@/sync/domains/social/friendTypes';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text/Text';
import { shadowLevelStyle } from '@/shadowElevation';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

const USERNAME_PREFIX = '@';


interface UserSearchResultProps {
    user: UserProfile;
    onAddFriend: () => void;
    isProcessing?: boolean;
}

export function UserSearchResult({ 
    user, 
    onAddFriend, 
    isProcessing = false 
}: UserSearchResultProps) {
    const router = useRouter();
    const displayName = getDisplayName(user);
    const avatarUrl = user.avatar?.url || user.avatar?.path;
    
    // Determine button state based on relationship status
    const getButtonContent = () => {
        if (isProcessing) {
            return <ActivitySpinner size="small" color="white" />;
        }
        
        switch (user.status) {
            case 'friend':
                return <Text style={styles.buttonTextDisabled}>{t('friends.alreadyFriends')}</Text>;
            case 'pending':
                return <Text style={styles.buttonTextDisabled}>{t('friends.requestPending')}</Text>;
            case 'requested':
                return <Text style={styles.buttonTextDisabled}>{t('friends.requestSent')}</Text>;
            default:
                return <Text style={styles.buttonText}>{t('friends.addFriend')}</Text>;
        }
    };
    
    const isDisabled = isProcessing || user.status === 'friend' || user.status === 'pending' || user.status === 'requested';

    return (
        <Pressable 
            style={styles.container}
            onPress={() => router.push(`/user/${user.id}`)}
        >
            <View style={styles.content}>
                <Avatar
                    id={user.id}
                    size={48}
                    imageUrl={avatarUrl}
                    thumbhash={user.avatar?.thumbhash}
                />
                
                <View style={styles.info}>
                    <Text style={styles.name}>{displayName}</Text>
                    <Text style={styles.username}>{USERNAME_PREFIX}{user.username}</Text>
                </View>

                <TouchableOpacity
                    style={[
                        styles.button, 
                        isDisabled && styles.buttonDisabled
                    ]}
                    onPress={onAddFriend}
                    disabled={isDisabled}
                >
                    {getButtonContent()}
                </TouchableOpacity>
            </View>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        marginHorizontal: 16,
        marginVertical: 4,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
    },
    info: {
        flex: 1,
        marginLeft: 16,
    },
    name: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text.primary,
        marginBottom: 2,
    },
    username: {
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
    button: {
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
        minWidth: 100,
        alignItems: 'center',
    },
    buttonDisabled: {
        backgroundColor: theme.colors.border.default,
    },
    buttonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 14,
        fontWeight: '600',
    },
    buttonTextDisabled: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        fontWeight: '500',
    },
}));
