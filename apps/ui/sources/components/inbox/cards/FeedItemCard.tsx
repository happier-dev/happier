import * as React from 'react';
import { FeedItem } from '@/sync/domains/social/feedTypes';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { useUser } from '@/sync/domains/state/storage';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';

interface FeedItemCardProps {
    item: FeedItem;
}

export const FeedItemCard = React.memo(({ item }: FeedItemCardProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    
    // Get user profile from global users cache for friend-related items
    // User MUST exist for friend-related items or they would have been filtered out
    const user = useUser(
        (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')
            ? item.body.uid 
            : undefined
    );
    
    switch (item.body.kind) {
        case 'friend_request': {
            const avatarElement = user!.avatar ? (
                <Avatar 
                    id={user!.id}
                    imageUrl={user!.avatar.url}
                    size={40}
                />
            ) : (
                <Icon name="person" size={20} color={theme.colors.text.secondary} />
            );
            
            return (
                <Item
                    title={t('feed.friendRequestFrom', { name: user!.firstName || user!.username })}
                    subtitle={formatRelativeTime(item.createdAt)}
                    leftElement={avatarElement}
                    onPress={() => router.push(`/user/${user!.id}`)}
                    showChevron={true}
                />
            );
        }
            
        case 'friend_accepted': {
            const avatarElement = user!.avatar ? (
                <Avatar 
                    id={user!.id}
                    imageUrl={user!.avatar.url}
                    size={40}
                />
            ) : (
                <Icon name="check-circle" size={20} color={theme.colors.status.connected} />
            );
            
            return (
                <Item
                    title={t('feed.friendAccepted', { name: user!.firstName || user!.username })}
                    subtitle={formatRelativeTime(item.createdAt)}
                    leftElement={avatarElement}
                    onPress={() => router.push(`/user/${user!.id}`)}
                    showChevron={true}
                />
            );
        }
            
        case 'text':
            return (
                <Item
                    title={item.body.text}
                    subtitle={formatRelativeTime(item.createdAt)}
                    icon={<Icon name="info" size={20} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            );
            
        default:
            return null;
    }
});
