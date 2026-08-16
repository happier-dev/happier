import * as React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionRightPanelAgentsView } from '@/components/sessions/panes/agents/SessionRightPanelAgentsView';
import { useCanDockSessionPane } from '@/components/sessions/panes/open/useSessionOpenLayout';
import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import {
    isSessionRouteHydrationAvailable,
    isSessionRouteHydrationMissing,
} from '@/sync/domains/session/sessionRouteHydrationState';
import { t } from '@/text';

/**
 * The agent roster, full screen — the destination a phone never had.
 *
 * The header's agents control opened the right pane unconditionally, and `resolvePaneLayout` returns
 * `right: 'hidden'` on every phone: the control was live, announced, counted, and did nothing. This
 * screen is the other half of the fix. `useOpenSessionTarget` decides which half applies.
 *
 * It renders `SessionRightPanelAgentsView` — the SAME host the right pane renders, which is the same
 * `AgentActivitySurface` the compact popover draws. Not a mobile variant of the roster: the roster
 * has one composition, and a second one would be the split-brain this corridor has spent its waves
 * removing. Everything that surface opens goes back through the same open decision, so an agent
 * pressed here lands on its own screen rather than in a pane this layout cannot draw.
 */
export default function SessionAgentsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = useSessionRouteServerScope(params as Record<string, unknown>);
    const sessionId = String(params.id ?? '').trim();
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionAgentsRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);
    const scopeId = resolveSessionPaneScopeId(sessionId);
    const pane = useAppPaneScope(scopeId);

    // The return direction of the same decision. A deep link, a rotation or a resized desktop window
    // can land this screen on a layout that has room for the Agents tab beside the transcript — and
    // this route is where a phone-sized answer gets stuck once the layout stops being phone-sized.
    // `/file` and `/commit` have handed back for a long time; the routes this corridor added did not.
    const canDockRightPane = useCanDockSessionPane('right');
    const shouldHandBackToPane = Boolean(sessionId) && sessionHydrated && canDockRightPane;

    React.useEffect(() => {
        if (!shouldHandBackToPane) return;
        pane.openRight({ tabId: 'agents' });
        pane.setRightTab('agents');
        router.replace(routeScope.buildHref(sessionId) as never);
    }, [pane, routeScope, router, sessionId, shouldHandBackToPane]);

    const screenOptions = React.useMemo(
        () => ({ headerShown: true, headerTitle: t('session.agentActivity.screenTitle') }),
        [],
    );

    if (shouldHandBackToPane) return null;

    return (
        <View
            testID="session-agents-screen"
            style={{ flex: 1, backgroundColor: theme.colors.background?.canvas ?? theme.colors.surface.base }}
        >
            <Stack.Screen options={screenOptions} />
            {!sessionId || sessionMissingAfterHydration ? (
                <SessionInvalidLinkFallback />
            ) : sessionHydrated ? (
                <SessionRightPanelAgentsView sessionId={sessionId} scopeId={scopeId} />
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            )}
        </View>
    );
}
