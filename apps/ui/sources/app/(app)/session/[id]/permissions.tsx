import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';

import { SessionRemotePermissionGrantsView } from '@/components/sessions/permissions/SessionRemotePermissionGrantsView';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { useProfile, useSession } from '@/sync/domains/state/storage';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { t } from '@/text';

export default function SessionRemotePermissionGrantsScreen() {
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

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        headerTitle: t('sessionRemotePermissionGrants.title'),
    }), []);

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return (
            <>
                <Stack.Screen options={screenOptions} />
                <SessionInvalidLinkFallback />
            </>
        );
    }

    if (!sessionHydrated || !session) {
        return (
            <View style={{ flex: 1 }}>
                <Stack.Screen options={screenOptions} />
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
                <Stack.Screen options={screenOptions} />
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
            <Stack.Screen options={screenOptions} />
            <SessionRemotePermissionGrantsView sessionId={sessionId} serverId={resolvedServerId} />
        </View>
    );
}
