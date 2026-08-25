import React from 'react';
import { useRouter } from 'expo-router';

import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';

export default function NewAutomationRoute() {
    const router = useRouter();
    const support = useAutomationsSupport();
    const draftId = React.useMemo(
        () => resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId,
        [],
    );

    React.useEffect(() => {
        if (support.loading) return;
        router.replace({
            pathname: '/new',
            params: {
                ...buildNewSessionLaunchRouteParams({ draftId }),
                ...(support.enabled ? { automation: '1' } : {}),
            },
        });
    }, [draftId, router, support.enabled, support.loading]);

    return null;
}
