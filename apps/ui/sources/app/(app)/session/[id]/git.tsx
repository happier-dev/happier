import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionRightPanel } from '@/components/sessions/panes/SessionRightPanel';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { buildSessionDetailsRouteQuery } from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteAutoRedirect } from '@/components/workspaceCockpit/useFullscreenDetailsRouteAutoRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { SessionFullscreenPaneSafeAreaView } from '@/components/sessions/panes/SessionFullscreenPaneSafeAreaView';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

export default function SessionGitScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id: sessionIdParam } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionGitRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const scopeId = `session:${sessionId}`;
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;
    const initializedRightPaneSessionRef = React.useRef<string | null>(null);

    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
    const detailsIsOpen = detailsState?.isOpen ?? false;

    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        if (initializedRightPaneSessionRef.current === sessionId) return;
        initializedRightPaneSessionRef.current = sessionId;
        openRight({ tabId: 'git' });
        if (pane.scopeState?.right?.activeTabId !== 'git') {
            setRightTab('git');
        }
    }, [isFocused, openRight, pane.scopeState?.right?.activeTabId, sessionId, setRightTab]);

    const handleNavigateToDetails = React.useCallback((key: string) => {
        const targetQuery = buildSessionDetailsRouteQuery(
            buildActiveDetailsRouteParams(detailsSelection.tabs, key),
            'git',
        );
        router.push({
            pathname: '/session/[id]/details',
            params: routeScope.withParams({
                id: sessionId,
                ...targetQuery,
            }),
        } as any);
    }, [detailsSelection.tabs, routeScope, router, sessionId]);

    useFullscreenDetailsRouteAutoRedirect({
        resetKey: sessionId,
        enabled: Boolean(sessionId) && !cockpitEnabled,
        isFocused,
        detailsIsOpen,
        detailsSelection,
        onNavigate: handleNavigateToDetails,
    });

    usePersistSessionMobileSurface({
        sessionId,
        surface: cockpitEnabled ? 'git' : null,
        serverId: routeScope.serverId,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [closeRight, navigation, routeScope, router, sessionId]);

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <SessionFullscreenPaneSafeAreaView
            testID={cockpitEnabled ? 'session-cockpit-route-screen' : 'session-git-screen'}
            includeTopInset={!cockpitEnabled}
        >
            {sessionHydrated ? (
                cockpitEnabled ? (
                    <SessionCockpitShell
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface="git"
                        safeAreaPadding={false}
                        routeServerId={routeScope.serverId}
                        routeHydrationState={routeHydrationState}
                    />
                ) : (
                    <SessionRightPanel
                        sessionId={sessionId}
                        scopeId={scopeId}
                        presentation="screen"
                        onRequestClose={onRequestClose}
                    />
                )
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner />
                </View>
            )}
        </SessionFullscreenPaneSafeAreaView>
    );
}
