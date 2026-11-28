import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionInfoBody } from '@/components/sessions/info/SessionInfoBody';
import { SessionHabitsSection } from '@/components/sessions/work/SessionSetupSections';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { resolveSessionListPreferredServerIdFromState } from '@/sync/domains/session/listing/sessionListLookupState';
import { storage } from '@/sync/domains/state/storage';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

/**
 * `/session/[id]/info`: the phone and direct-link host of the Session's Info. It resolves the exact
 * address (an explicit Home wins; bare ids fall back to the canonical lookup) and its hydration, then
 * renders the same body the right-rail Info panel does.
 */
export const WorkspaceRouteBody = () => {
    const router = useRouter();
    const params = useLocalSearchParams<{ id: string; serverId?: string; section?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const sessionId = normalizeSessionId(params.id);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionInfoRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const session = useSessionViewShellSession(sessionId, routeScope.serverId);
    const sessionServerId = React.useMemo(() => {
        if (routeScope.serverId) return routeScope.serverId;
        const directFallback = String(session?.serverId ?? '').trim() || null;
        const listPreferredServerId = resolveSessionListPreferredServerIdFromState(
            storage.getState(),
            sessionId,
            directFallback,
        );
        const canonicalServerId = resolvePreferredServerIdForSessionId(sessionId);
        const resolvedServerId = canonicalServerId ?? listPreferredServerId ?? directFallback;
        const normalizedServerId = String(resolvedServerId ?? directFallback ?? '').trim();
        return normalizedServerId || null;
    }, [routeScope.serverId, session?.serverId, sessionId]);
    const address = React.useMemo(() => normalizeSessionAddress(sessionServerId, sessionId), [sessionId, sessionServerId]);
    const close = React.useCallback(() => safeRouterBack({ router, fallbackHref: '/' }), [router]);

    // Route pending: a sized loading state. If the session record is already present, fail open and
    // render it; otherwise deep links can get stuck when the local record is ahead of the route check.
    if (!session && !sessionHydrated && !isSessionRouteHydrationMissing(routeHydrationState)) {
        return (
            <View testID="session-info-screen" style={styles.state}>
                <SurfaceStateCard testID="session-info-loading" kind="loading" title={t('common.loading')} />
            </View>
        );
    }
    if (!address) {
        return (
            <View testID="session-info-screen" style={styles.state}>
                <SurfaceStateCard
                    testID="session-info-missing"
                    kind="unavailable"
                    title={t('errors.sessionDeleted')}
                    reason={t('errors.sessionDeletedDescription')}
                />
            </View>
        );
    }
    if (params.section === 'automations') return <ItemList>
        <SessionHabitsSection sessionId={address.sessionId} serverId={address.serverId} />
    </ItemList>;
    return <SessionInfoBody address={address} presentation="route" onRequestClose={close} />;
};

const styles = StyleSheet.create((theme) => ({
    state: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space.s16,
    },
}));

export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
