import * as React from 'react';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useFriendsAddAction } from '@/hooks/friends/useFriendsAddAction';
import { t } from '@/text';

export function FriendsAddButton() {
    const { isReady, openSearch } = useFriendsAddAction();
    return <IconButton
        testID="friends-add-friend"
        accessibilityLabel={t('friends.addFriend')}
        iconName="user-plus"
        variant="plain"
        disabled={!isReady}
        onPress={openSearch}
    />;
}
