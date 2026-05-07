import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useNavigation, usePathname, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionFullscreenPaneSafeAreaView } from '@/components/sessions/panes/SessionFullscreenPaneSafeAreaView';
import { SessionRightPanel } from '@/components/sessions/panes/SessionRightPanel';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteAutoRedirect } from '@/components/workspaceCockpit/useFullscreenDetailsRouteAutoRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildSessionDetailsRouteQuery } from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { prepareMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';

export default function TerminalScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const pathname = usePathname();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const { id: sessionIdParam } = params;
    const sessionId = String(sessionIdParam ?? '').trim();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const sessionHydrated = useHydrateSessionForRoute(
        sessionId,
        'SessionTerminalRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability({
        sessionId,
        serverId: routeScope.serverId ?? null,
    });
    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
    }), [detailsState?.activeTabKey, detailsState?.tabs]);
    const detailsIsOpen = detailsState?.isOpen ?? false;

    // Navigate back if terminal tab is unavailable (feature disabled or docked elsewhere)
    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        if (!sessionHydrated) return;
        if (!terminalTabAvailable) {
            safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
        }
    }, [isFocused, navigation, routeScope, router, sessionId, sessionHydrated, terminalTabAvailable]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        if (!terminalTabAvailable) return;
        openRight({ tabId: 'terminal' });
        setRightTab('terminal');
    }, [isFocused, openRight, sessionId, setRightTab, terminalTabAvailable]);

    const handleNavigateToDetails = React.useCallback((key: string) => {
        const targetHref = resolveSessionRoutePathForSurface(sessionId, 'tabs', {
            serverId: routeScope.serverId,
            query: buildSessionDetailsRouteQuery(
                buildActiveDetailsRouteParams(detailsSelection.tabs, key),
                'terminal',
            ),
        });
        prepareMobileSurfaceTransition({
            currentPathname: pathname,
            targetHref,
            operation: 'push',
        });
        router.push(targetHref as never);
    }, [detailsSelection.tabs, pathname, routeScope, router, sessionId]);

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
        surface: cockpitEnabled && terminalTabAvailable ? 'terminal' : null,
        enabled: isFocused,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [closeRight, navigation, routeScope, router, sessionId]);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <SessionFullscreenPaneSafeAreaView
            testID={cockpitEnabled ? 'session-cockpit-route-screen' : 'session-terminal-screen'}
            includeTopInset={!cockpitEnabled}
        >
            {sessionHydrated ? (
                cockpitEnabled ? (
                    <SessionCockpitShell
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface="terminal"
                        routeServerId={routeScope.serverId ?? undefined}
                        safeAreaPadding={false}
                        terminalTabAvailable={terminalTabAvailable}
                    />
                ) : (
                    <SessionRightPanel
                        sessionId={sessionId}
                        scopeId={scopeId}
                        serverId={routeScope.serverId ?? null}
                        presentation="screen"
                        onRequestClose={onRequestClose}
                    />
                )
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}
        </SessionFullscreenPaneSafeAreaView>
    );
}
