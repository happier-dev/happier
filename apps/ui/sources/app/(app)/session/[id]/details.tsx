import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import { applySessionPaneUrlState, parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function SessionDetailsScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; details?: string; path?: string; sha?: string }>();
    const { id: sessionIdParam } = params;
    const sessionId = String(sessionIdParam ?? '').trim();
    const sessionHydrated = useHydrateSessionForRoute(sessionId, 'SessionDetailsRoute.ensureSessionVisible');
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const routeDetailsState = React.useMemo(() => {
        const parsed = parseSessionPaneUrlState(params as Record<string, unknown>);
        return parsed?.details ? { details: parsed.details } : null;
    }, [params]);

    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const hasDetails = detailsTabs.length > 0;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const hasMountedRef = React.useRef(false);
    const prevDetailsIsOpenRef = React.useRef(detailsIsOpen);
    const returnToSession = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: `/session/${sessionId}` });
    }, [navigation, router, sessionId]);

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
        if (!hasDetails && routeDetailsState) return;
        if (!hasDetails) returnToSession();
    }, [hasDetails, isFocused, returnToSession, routeDetailsState, sessionHydrated, sessionId]);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!isFocused) return;
        if (!sessionHydrated) return;
        if (!hasMountedRef.current) return;
        // When the details pane is closed in pane state, treat this fullscreen route as dismissed.
        if (prevDetailsIsOpenRef.current && !detailsIsOpen) returnToSession();
        prevDetailsIsOpenRef.current = detailsIsOpen;
    }, [detailsIsOpen, isFocused, returnToSession, sessionHydrated, sessionId]);

    const onRequestClose = React.useCallback(() => {
        if (!detailsIsOpen) {
            returnToSession();
            return;
        }
        pane.closeDetails();
    }, [detailsIsOpen, pane, returnToSession]);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <View testID="session-details-screen" style={{ flex: 1 }}>
            {sessionHydrated ? (
                <SessionDetailsPanel sessionId={sessionId} scopeId={scopeId} onRequestClose={onRequestClose} />
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}
        </View>
    );
}
