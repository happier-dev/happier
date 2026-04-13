import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import { applySessionPaneUrlState, parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function SessionDetailsScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string; details?: string; path?: string; sha?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id: sessionIdParam } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const sessionHydrated = useHydrateSessionForRoute(
        sessionId,
        'SessionDetailsRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const scopeId = `session:${sessionId}`;
    const pane = useAppPaneScope(scopeId);
    const parsedRouteDetailsState = parseSessionPaneUrlState(params as Record<string, unknown>);
    const routeDetailsState = parsedRouteDetailsState?.details ? { details: parsedRouteDetailsState.details } : null;

    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const hasDetails = detailsTabs.length > 0;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const hasMountedRef = React.useRef(false);
    const prevDetailsIsOpenRef = React.useRef(detailsIsOpen);
    const returnToSession = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [navigation, routeScope, router, sessionId]);

    React.useEffect(() => {
        hasMountedRef.current = true;
        return () => {
            hasMountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!isFocused) return;
        if (!sessionHydrated) return;
        if (hasDetails) return;
        if (!routeDetailsState) return;
        applySessionPaneUrlState(pane, routeDetailsState);
    }, [hasDetails, isFocused, pane, routeDetailsState, sessionHydrated, sessionId]);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!isFocused) return;
        if (!sessionHydrated) return;
        // If there is no active details content, this screen has nothing to show.
        // Navigate back to the previous screen (typically the session or sidebar screen).
        if (!hasMountedRef.current) return;
        if (cockpitEnabled) return;
        if (!hasDetails && routeDetailsState) return;
        if (!hasDetails) returnToSession();
    }, [cockpitEnabled, hasDetails, isFocused, returnToSession, routeDetailsState, sessionHydrated, sessionId]);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!isFocused) return;
        if (!sessionHydrated) return;
        if (!hasMountedRef.current) return;
        if (cockpitEnabled) return;
        // When the details pane is closed in pane state, treat this fullscreen route as dismissed.
        if (prevDetailsIsOpenRef.current && !detailsIsOpen) returnToSession();
        prevDetailsIsOpenRef.current = detailsIsOpen;
    }, [cockpitEnabled, detailsIsOpen, isFocused, returnToSession, sessionHydrated, sessionId]);

    const onRequestClose = React.useCallback(() => {
        if (!detailsIsOpen) {
            returnToSession();
            return;
        }
        pane.closeDetails();
    }, [detailsIsOpen, pane, returnToSession]);

    usePersistSessionMobileSurface({
        sessionId,
        surface: cockpitEnabled ? 'tabs' : null,
    });

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <View testID={cockpitEnabled ? undefined : 'session-details-screen'} style={{ flex: 1 }}>
            {sessionHydrated ? (
                cockpitEnabled ? (
                    <SessionCockpitShell sessionId={sessionId} scopeId={scopeId} surface="tabs" />
                ) : (
                    <SessionDetailsPanel sessionId={sessionId} scopeId={scopeId} onRequestClose={onRequestClose} />
                )
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}
        </View>
    );
}
