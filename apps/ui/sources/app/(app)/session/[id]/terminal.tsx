import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionRightPanel } from '@/components/sessions/panes/SessionRightPanel';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { buildSessionDetailsRouteQuery } from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { useSessionCockpitLegacyLeafRedirect } from '@/components/workspaceCockpit/session/useSessionCockpitLegacyLeafRedirect';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteAutoRedirect } from '@/components/workspaceCockpit/useFullscreenDetailsRouteAutoRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { SessionFullscreenPaneSafeAreaView } from '@/components/sessions/panes/SessionFullscreenPaneSafeAreaView';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId, useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { getRightSidebarBuiltinTab } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { t } from '@/text';

export function TerminalScreenRoute() {
    useDestinationPageTitle(t(getRightSidebarBuiltinTab('terminal').labelKey));
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id: sessionIdParam } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionTerminalRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(sessionId, routeScope.serverId));
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;
    const initializedRightPaneSessionRef = React.useRef<string | null>(null);

    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const { terminalEnabled, dockLocation, sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability(routeScope.serverId);
    const redirectingToCockpit = useSessionCockpitLegacyLeafRedirect({
        leaf: 'terminal', sessionId, params, cockpitEnabled, terminalTabAvailable,
    });

    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
    const detailsIsOpen = detailsState?.isOpen ?? false;

    // A desktop Terminal entry addresses the same destination's bottom dock,
    // not whichever scene happens to precede this child route in history.
    React.useEffect(() => {
        if (redirectingToCockpit) return;
        if (!isFocused) return;
        if (!sessionId) return;
        if (!sessionHydrated) return;
        if (terminalEnabled && dockLocation === 'bottom') {
            router.replace({ pathname: '/session/[id]', params: routeScope.withParams({ id: sessionId, bottom: 'terminal' }) });
        } else if (!terminalEnabled) {
            safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
        }
    }, [isFocused, navigation, redirectingToCockpit, routeScope, router, sessionId, sessionHydrated, terminalEnabled, dockLocation]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        if (!terminalTabAvailable) return;
        if (initializedRightPaneSessionRef.current === sessionId) return;
        initializedRightPaneSessionRef.current = sessionId;
        openRight({ tabId: 'terminal' });
        if (pane.scopeState?.right?.activeTabId !== 'terminal') {
            setRightTab('terminal');
        }
    }, [isFocused, openRight, pane.scopeState?.right?.activeTabId, sessionId, setRightTab, terminalTabAvailable]);

    const handleNavigateToDetails = React.useCallback((key: string) => {
        const targetQuery = buildSessionDetailsRouteQuery(
            buildActiveDetailsRouteParams(detailsSelection.tabs, key, detailsState?.tabState),
            'terminal',
        );
        router.push({
            pathname: '/session/[id]/details',
            params: routeScope.withParams({
                id: sessionId,
                ...targetQuery,
            }),
        } as any);
    }, [detailsSelection.tabs, detailsState?.tabState, routeScope, router, sessionId]);

    useFullscreenDetailsRouteAutoRedirect({
        resetKey: sessionId,
        enabled: Boolean(sessionId) && !cockpitEnabled,
        isFocused,
        detailsIsOpen,
        detailsSelection,
        onNavigate: handleNavigateToDetails,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [closeRight, navigation, routeScope, router, sessionId]);

    if (redirectingToCockpit) return null;

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <SessionFullscreenPaneSafeAreaView testID="session-terminal-screen" includeTopInset>
            {sessionHydrated ? (
                <SessionRightPanel
                    sessionId={sessionId}
                    scopeId={scopeId}
                    presentation="screen"
                    onRequestClose={onRequestClose}
                />
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner />
                </View>
            )}
        </SessionFullscreenPaneSafeAreaView>
    );
}

export { TerminalScreenRoute as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={TerminalScreenRoute} />; }
