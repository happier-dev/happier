import * as React from 'react';
import { useRouter } from 'expo-router';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * A people directory with no one to offer, or a people search that found no one. The directory lists only
 * people the viewer is connected with, so its empty state says that and leads to the existing way of
 * connecting (Friends).
 */
export const ShareConnectedPeoplePrompt = React.memo(function ShareConnectedPeoplePrompt(props: Readonly<{ testID: string; query?: string }>) {
    const router = useRouter();
    return <SurfaceStateCard testID={props.testID} kind="empty" size="line"
        title={props.query ? t('shareSheet.noMatchingPeople', { query: props.query }) : t('shareSheet.noConnectedPeople')}
        action={{ label: t('friends.findFriends'), testID: `${props.testID}-find-friends`, onPress: () => router.push('/friends') }} />;
});
