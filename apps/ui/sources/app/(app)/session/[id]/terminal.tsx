import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionRightPanel } from '@/components/sessions/panes/SessionRightPanel';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteAutoRedirect } from '@/components/workspaceCockpit/useFullscreenDetailsRouteAutoRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';

export default function TerminalScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id: sessionIdParam } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const sessionHydrated = useHydrateSessionForRoute(
        sessionId,
        'SessionTerminalRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const scopeId = `session:${sessionId}`;
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability();

    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
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
        router.push({
            pathname: '/session/[id]/details',
            params: routeScope.withParams({
                id: sessionId,
                ...buildActiveDetailsRouteParams(detailsSelection.tabs, key),
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
        surface: cockpitEnabled && terminalTabAvailable ? 'terminal' : null,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [closeRight, navigation, routeScope, router, sessionId]);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <View testID={cockpitEnabled ? undefined : 'session-terminal-screen'} style={{ flex: 1 }}>
            {sessionHydrated ? (
                cockpitEnabled ? (
                    <SessionCockpitShell
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface="terminal"
                        terminalTabAvailable={terminalTabAvailable}
                    />
                ) : (
                    <SessionRightPanel sessionId={sessionId} scopeId={scopeId} onRequestClose={onRequestClose} />
                )
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}
        </View>
    );
}
