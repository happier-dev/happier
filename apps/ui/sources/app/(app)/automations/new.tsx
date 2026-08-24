import React from 'react';
import { useRouter } from 'expo-router';

import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';

export default function NewAutomationRoute() {
    const router = useRouter();
    const support = useAutomationsSupport();

    React.useEffect(() => {
        if (support.loading) return;
        const draftId = resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId;
        router.replace({
            pathname: '/new',
            params: {
                ...buildNewSessionLaunchRouteParams({ draftId }),
                ...(support.enabled ? { automation: '1' } : {}),
            },
        });
    }, [router, support.enabled, support.loading]);

    return null;
}
