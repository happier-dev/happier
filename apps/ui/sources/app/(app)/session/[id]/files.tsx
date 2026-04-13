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
import { useLegacyDetailsRouteRedirect } from '@/components/workspaceCockpit/useLegacyDetailsRouteRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function FilesScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id: sessionIdParam } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const sessionHydrated = useHydrateSessionForRoute(
        sessionId,
        'SessionFilesRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const scopeId = `session:${sessionId}`;
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const activeDetailsKey = pane.scopeState?.details?.activeTabKey ?? null;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];

    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        openRight({ tabId: 'files' });
        if (pane.scopeState?.right?.activeTabId !== 'files') {
            setRightTab('files');
        }
    }, [isFocused, openRight, sessionId, setRightTab, pane.scopeState?.right?.activeTabId]);

    const handleNavigateToDetails = React.useCallback((key: string) => {
        router.push({
            pathname: '/session/[id]/details',
            params: routeScope.withParams({
                id: sessionId,
                ...buildActiveDetailsRouteParams(detailsTabs, key),
            }),
        } as any);
    }, [detailsTabs, routeScope, router, sessionId]);

    useLegacyDetailsRouteRedirect({
        resetKey: sessionId,
        enabled: Boolean(sessionId) && !cockpitEnabled,
        isFocused,
        detailsIsOpen,
        activeDetailsKey,
        detailsTabs,
        onNavigate: handleNavigateToDetails,
    });

    usePersistSessionMobileSurface({
        sessionId,
        surface: cockpitEnabled ? 'browse' : null,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [closeRight, navigation, routeScope, router, sessionId]);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <View testID={cockpitEnabled ? undefined : 'session-files-screen'} style={{ flex: 1 }}>
            {sessionHydrated ? (
                cockpitEnabled ? (
                    <SessionCockpitShell sessionId={sessionId} scopeId={scopeId} surface="browse" />
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
