import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { UsagePanel } from '@/components/settings/usage/UsagePanel';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';

export default function SessionUsageScreenRoute() {
    const params = useLocalSearchParams<{ id: string; serverId?: string | string[] }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const sessionId = normalizeSessionId(params.id);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionUsageRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return <SessionInvalidLinkFallback />;
    }

    if (!isSessionRouteHydrationAvailable(routeHydrationState)) {
        return <ActivitySpinner size="small" />;
    }

    return <UsagePanel sessionId={sessionId} />;
}
