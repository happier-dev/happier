import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { SessionRemotePermissionGrantsView } from '@/components/sessions/permissions/SessionRemotePermissionGrantsView';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { buildScopedSessionRouteHref, createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { useProfile, useSession } from '@/sync/domains/state/storage';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { t } from '@/text';

export function SessionRemotePermissionGrantsScreen() {
    const inheritedBack = useNavigationBackControl();
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[] }>();
    const sessionId = normalizeSessionId(params.id);
    // A phone opened straight on Allowed (no history) goes back to its Session, never to a dead end.
    const phoneBack = usePhoneDestinationBack('session-allowed:back',
        buildScopedSessionRouteHref({ sessionId: sessionId ?? '', serverId: createSessionRouteServerScope(params as Record<string, unknown>).serverId }));
    return (
        <NavigationBackChromeProvider control={phoneBack ?? inheritedBack}>
            <SessionRemotePermissionGrantsBody />
        </NavigationBackChromeProvider>
    );
}

function SessionRemotePermissionGrantsBody() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[] }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const sessionId = normalizeSessionId(params.id);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionRemotePermissionGrantsRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const session = useSession(sessionId);
    const profile = useProfile();
    const currentUserId = typeof profile?.id === 'string' ? profile.id : null;
    const resolvedServerId = React.useMemo(() => {
        const routeServerId = String(routeScope.serverId ?? '').trim();
        if (routeServerId) return routeServerId;
        const preferredServerId = String(resolvePreferredServerIdForSessionId(sessionId) ?? '').trim();
        if (preferredServerId) return preferredServerId;
        const directServerId = String(session?.serverId ?? '').trim();
        return directServerId || null;
    }, [routeScope.serverId, session?.serverId, sessionId]);
    const sessionActionTarget = React.useMemo(() => session
        ? createSessionActionTarget({ session, serverId: resolvedServerId, currentUserId })
        : null,
    [currentUserId, resolvedServerId, session]);

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return (
            <SessionInvalidLinkFallback />
        );
    }

    if (!sessionHydrated || !session) {
        return (
            <View style={{ flex: 1 }}>
                <SurfaceStateCard
                    testID="session-remote-permission-grants-route-loading"
                    kind="loading"
                    title={t('sessionRemotePermissionGrants.loadingTitle')}
                    reason={t('sessionRemotePermissionGrants.loadingReason')}
                    accessibilitySemantics="status"
                />
            </View>
        );
    }

    if (!sessionActionTarget?.isOwnedByCurrentUser) {
        return (
            <View style={{ flex: 1 }}>
                <SurfaceStateCard
                    testID="session-remote-permission-grants-owner-only"
                    kind="unavailable"
                    title={t('sessionRemotePermissionGrants.ownerOnlyTitle')}
                    reason={t('sessionRemotePermissionGrants.ownerOnlyReason')}
                    accessibilitySemantics="alert"
                />
            </View>
        );
    }

    return (
        <View style={{ flex: 1 }}>
            <SessionRemotePermissionGrantsView sessionId={sessionId} serverId={resolvedServerId}
                machineId={readSessionOwnerMetadataView(session)?.machineId ?? null} />
        </View>
    );
}

export { SessionRemotePermissionGrantsScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionRemotePermissionGrantsScreen} />; }
