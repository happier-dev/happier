import * as React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionTranscriptDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SessionTranscriptDetailsView } from '@/components/sessions/panes/details/SessionTranscriptDetailsView';
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
 * An agent's transcript, full screen.
 *
 * An imported workflow-agent sidechain has no owning tool message, so `resolveSessionSubagentFullRoute`
 * cannot address it and it had exactly one destination: a details tab, which exists only where a
 * details pane does. On a phone that meant the transcript could be previewed and never read. This
 * screen is where the same target lands when the layout has no pane for it.
 *
 * It renders `SessionTranscriptDetailsView` — the same view the details tab hosts, which is
 * `SidechainTranscriptBody`, which is `ChainTranscriptList`: the same message, turn and tool rows the
 * main transcript draws. One renderer, two frames.
 */
function readParam(value: string | string[] | undefined): string {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return String(value[0] ?? '').trim();
    return '';
}

export default function SessionAgentTranscriptScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ id: string; serverId?: string; sidechainId?: string; title?: string }>();
    const routeScope = useSessionRouteServerScope(params as Record<string, unknown>);
    const sessionId = readParam(params.id);
    const sidechainId = readParam(params.sidechainId);
    const title = readParam(params.title);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionAgentTranscriptRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);

    const screenOptions = React.useMemo(
        () => ({
            headerShown: true,
            // The agent's own name when the opener knew it, never a blank header: an imported sidecar
            // can arrive before its agent is named.
            headerTitle: title || t('session.agentActivity.transcriptScreenTitle'),
        }),
        [title],
    );

    const scope = React.useMemo(
        () => ({ kind: 'sidechain' as const, sessionId, sidechainId }),
        [sessionId, sidechainId],
    );

    const pane = useAppPaneScope(resolveSessionPaneScopeId(sessionId));
    // The return direction, same owner as `/file` and `/commit`: a deep link that lands on a window
    // wide enough for a docked details pane hands the transcript back to it instead of holding a
    // full screen the layout no longer needs.
    const canDockDetailsPane = useCanDockSessionPane('details');
    const shouldHandBackToPane =
        Boolean(sessionId) && Boolean(sidechainId) && sessionHydrated && canDockDetailsPane;

    React.useEffect(() => {
        if (!shouldHandBackToPane) return;
        pane.openDetailsTab(
            createSessionTranscriptDetailsTab({ scope, title: title || null }),
            { intent: 'preview' },
        );
        router.replace(routeScope.buildHref(sessionId) as never);
    }, [pane, routeScope, router, scope, sessionId, shouldHandBackToPane, title]);

    if (shouldHandBackToPane) return null;

    return (
        <View
            testID="session-agent-transcript-screen"
            style={{ flex: 1, backgroundColor: theme.colors.background?.canvas ?? theme.colors.surface.base }}
        >
            <Stack.Screen options={screenOptions} />
            {!sessionId || !sidechainId || sessionMissingAfterHydration ? (
                <SessionInvalidLinkFallback />
            ) : sessionHydrated ? (
                <SessionTranscriptDetailsView scope={scope} testID="session-agent-transcript" />
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            )}
        </View>
    );
}
