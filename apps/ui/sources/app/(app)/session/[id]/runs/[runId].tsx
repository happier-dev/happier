import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DetailsStartSheetHost } from '@/components/appShell/panes/panePresentation';
import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import {
    SessionExecutionRunDetailsView,
    type SessionExecutionRunDetailsViewHandle,
} from '@/components/sessions/runs/details/SessionExecutionRunDetailsView';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { buildScopedSessionRouteHref, createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

function normalizeParam(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
    return null;
}

export function SessionRunDetailsScreen() {
    const { theme } = useUnistyles();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[]; runId?: string | string[]; retryInputLocalId?: string | string[] }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const sessionId = normalizeSessionId(params.id);
    const runId = normalizeParam(params.runId);
    const retryInputLocalId = normalizeParam(params.retryInputLocalId);
    const routeHydrationState = useHydrateSessionForRoute(sessionId, 'SessionRunDetailsScreen.hydrate', routeScope.hydrationOptions);
    const hydrateReady = isSessionRouteHydrationAvailable(routeHydrationState);
    const hydrateMissing = isSessionRouteHydrationMissing(routeHydrationState);
    const exactSessionServerId = routeHydrationState.serverId ?? routeScope.serverId;
    const detailsRef = React.useRef<SessionExecutionRunDetailsViewHandle | null>(null);
    const headerTint = theme.colors.chrome.header.foreground ?? theme.colors.text.primary;
    const parentSessionHref = sessionId
        ? buildScopedSessionRouteHref({ sessionId, serverId: exactSessionServerId })
        : '/';

    const headerRight = React.useCallback(() => (
        <HappierPressable
            accessibilityRole="button"
            accessibilityLabel={t('runs.runDetails.a11y.refreshRun')}
            onPress={() => {
                void detailsRef.current?.reload();
            }}
            testID="session-run-details-refresh"
            style={({ pressed }) => ({ padding: theme.space.s4, opacity: pressed ? motionTokens.press.opacity : 1 })}
        >
            <Icon name="arrow-clockwise" size={20} color={headerTint} />
        </HappierPressable>
    ), [headerTint]);

    const headerLeft = React.useCallback(() => (
        <HappierPressable
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            onPress={() => safeRouterBack({
                router,
                navigation,
                fallbackHref: parentSessionHref,
            })}
            testID="session-run-details-back"
            style={({ pressed }) => ({ padding: theme.space.s4, opacity: pressed ? motionTokens.press.opacity : 1 })}
        >
            <Icon name="arrow-left" size={20} color={headerTint} />
        </HappierPressable>
    ), [headerTint, navigation, parentSessionHref, router]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        // The Run's own header (its mark, title and status) leads the page; the navigation bar
        // names where Back returns to, never the Run's id (agents lab RP1p).
        headerTitle: t('session.subagents.panel.title'),
        headerLeft,
        headerRight,
    }), [headerLeft, headerRight]);

    // The Run reads on the page paper like its Session; the canvas is the navigation plane.
    return (
        <View style={{ flex: 1, paddingBottom: bottomChromeHeight }}>
            <Stack.Screen options={screenOptions} />
            {!hydrateReady && !hydrateMissing ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : !sessionId || !runId || hydrateMissing ? (
                <SessionInvalidLinkFallback />
            ) : (
                <DetailsStartSheetHost><SessionExecutionRunDetailsView
                    ref={detailsRef}
                    sessionId={sessionId}
                    runId={runId}
                    serverId={exactSessionServerId}
                    retryInputLocalId={retryInputLocalId ?? undefined}
                    presentation="screen"
                /></DetailsStartSheetHost>
            )}
        </View>
    );
}

export { SessionRunDetailsScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionRunDetailsScreen} />; }
