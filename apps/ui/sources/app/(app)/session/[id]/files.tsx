import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionFullscreenPaneSafeAreaView } from '@/components/sessions/panes/SessionFullscreenPaneSafeAreaView';
import { SessionRightPanel } from '@/components/sessions/panes/SessionRightPanel';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteAutoRedirect } from '@/components/workspaceCockpit/useFullscreenDetailsRouteAutoRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildSessionDetailsRouteQuery } from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';

export default function FilesScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const { id: sessionIdParam } = params;
    const sessionId = String(sessionIdParam ?? '').trim();
    const routeScope = useSessionRouteServerScope(params);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionFilesRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);
    const scopeId = React.useMemo(() => resolveSessionPaneScopeId(sessionId), [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
    }), [detailsState?.activeTabKey, detailsState?.tabs]);
    const detailsIsOpen = detailsState?.isOpen ?? false;
    const initializedRightPaneSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        if (!sessionHydrated) return;
        if (initializedRightPaneSessionRef.current === sessionId) return;
        initializedRightPaneSessionRef.current = sessionId;
        openRight({ tabId: 'files' });
        if (pane.scopeState?.right?.activeTabId !== 'files') {
            setRightTab('files');
        }
    }, [isFocused, openRight, sessionHydrated, sessionId, setRightTab, pane.scopeState?.right?.activeTabId]);

    const handleNavigateToDetails = React.useCallback((key: string) => {
        const targetHref = resolveSessionRoutePathForSurface(sessionId, 'tabs', {
            serverId: routeScope.serverId,
            query: buildSessionDetailsRouteQuery(
                buildActiveDetailsRouteParams(detailsSelection.tabs, key),
                'browse',
            ),
        });
        router.push(targetHref as never);
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
        surface: cockpitEnabled ? 'browse' : null,
        enabled: isFocused,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [closeRight, navigation, routeScope, router, sessionId]);

    if (!sessionId || sessionMissingAfterHydration) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <SessionFullscreenPaneSafeAreaView
            testID={cockpitEnabled ? 'session-cockpit-route-screen' : 'session-files-screen'}
            includeTopInset={!cockpitEnabled}
        >
            {sessionHydrated ? (
                cockpitEnabled ? (
                    <SessionCockpitShell
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface="browse"
                        routeServerId={routeScope.serverId ?? undefined}
                        routeHydrationState={routeHydrationState}
                        safeAreaPadding={false}
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
                    <ActivitySpinner />
                </View>
            )}
        </SessionFullscreenPaneSafeAreaView>
    );
}
