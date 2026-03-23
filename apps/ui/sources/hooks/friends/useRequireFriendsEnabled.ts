import * as React from 'react';
import { useRouter } from 'expo-router';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

export function useRequireFriendsEnabled(): boolean {
    const router = useRouter();
    const decision = useFeatureDecision('social.friends', { scopeKind: 'runtime' });
    const enabled = decision?.state === 'enabled';

    React.useEffect(() => {
        if (decision === null) return;
        if (enabled) return;
        router.replace('/');
    }, [decision, enabled, router]);

    return enabled;
}
