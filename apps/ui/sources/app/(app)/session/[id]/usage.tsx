import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { UsageWidgetPage } from '@/components/settings/usage/UsageWidgetPage';
import { buildUsageRouteParams, resolveUsagePageInitialFilters } from '@/components/settings/usage/usageRouteParams';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';

export function SessionUsageScreenRoute() {
    const params = useLocalSearchParams<{ id: string; serverId?: string | string[] }>();
    const router = useRouter();
    const initialFilters = React.useMemo(() => resolveUsagePageInitialFilters(params), [params]);
    const handleFiltersChange = React.useCallback((filters: Parameters<typeof buildUsageRouteParams>[0]) => {
        const { layoutId: _layoutId, ...owned } = buildUsageRouteParams(filters);
        router.setParams(owned);
    }, [router]);
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

    return <UsageWidgetPage sessionId={sessionId} initialFilters={initialFilters} onFiltersChange={handleFiltersChange} />;
}

export { SessionUsageScreenRoute as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionUsageScreenRoute} />; }
