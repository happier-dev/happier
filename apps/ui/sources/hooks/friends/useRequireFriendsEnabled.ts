import * as React from 'react';
import { useRouter } from 'expo-router';

import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';

export function useRequireFriendsEnabled(): boolean {
    const router = useRouter();
    const enabled = useFriendsEnabled();

    React.useEffect(() => {
        if (enabled) return;
        router.replace('/');
    }, [enabled, router]);

    return enabled;
}

