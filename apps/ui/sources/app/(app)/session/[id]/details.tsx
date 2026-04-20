import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import {
    applySessionPaneUrlState,
    buildActiveDetailsRouteParams,
    parseSessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { useFullscreenDetailsRouteController } from '@/components/workspaceCockpit/useFullscreenDetailsRouteController';
import { useFullscreenDetailsRouteParamSync } from '@/components/workspaceCockpit/useFullscreenDetailsRouteParamSync';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

type SessionDetailsRouteParamsShape = Readonly<{
    details?: string;
    path?: string;
    sha?: string;
    terminalInstanceId?: string;
}>;

function createDetailsRouteParamsSignature(params: SessionDetailsRouteParamsShape): string {
    return [
        params.details ?? '',
        params.path ?? '',
        params.sha ?? '',
        params.terminalInstanceId ?? '',
    ].join('|');
}

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
    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
    const parsedRouteDetailsState = parseSessionPaneUrlState(params as Record<string, unknown>);
    const routeDetailsState = parsedRouteDetailsState?.details ? { details: parsedRouteDetailsState.details } : null;
    const hasDetails = detailsSelection.hasAnyDetails;
    const detailsIsOpen = detailsState?.isOpen ?? false;
    const routeDetailsParams = React.useMemo<SessionDetailsRouteParamsShape>(() => ({
        details: typeof params.details === 'string' ? params.details : undefined,
        path: typeof params.path === 'string' ? params.path : undefined,
        sha: typeof params.sha === 'string' ? params.sha : undefined,
        terminalInstanceId: typeof (params as { terminalInstanceId?: unknown }).terminalInstanceId === 'string'
            ? (params as { terminalInstanceId?: string }).terminalInstanceId
            : undefined,
    }), [params]);
    const selectedDetailsParams = React.useMemo<SessionDetailsRouteParamsShape>(() => {
        const next = buildActiveDetailsRouteParams(detailsSelection.tabs, detailsSelection.activeKey);
        return {
            details: next.details,
            path: next.path,
            sha: next.sha,
            terminalInstanceId: next.terminalInstanceId,
        };
    }, [detailsSelection.activeKey, detailsSelection.tabs]);
    const routeDetailsSignature = React.useMemo(
        () => createDetailsRouteParamsSignature(routeDetailsParams),
        [routeDetailsParams],
    );
    const selectedDetailsSignature = React.useMemo(
        () => createDetailsRouteParamsSignature(selectedDetailsParams),
        [selectedDetailsParams],
    );
    const returnToSession = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: routeScope.buildHref(sessionId) });
    }, [navigation, routeScope, router, sessionId]);

    useFullscreenDetailsRouteParamSync({
        resetKey: sessionId,
        enabled: Boolean(sessionId),
        isFocused,
        hydrated: sessionHydrated,
        hasRouteSelection: Boolean(routeDetailsState),
        hasSelectedSelection: Boolean(selectedDetailsParams.details),
        routeSelectionSignature: routeDetailsSignature,
        selectedSelectionSignature: selectedDetailsSignature,
        onApplyRouteSelection: React.useCallback(() => {
            if (!routeDetailsState) {
                return;
            }
            applySessionPaneUrlState(pane, routeDetailsState);
        }, [pane, routeDetailsState]),
        onWriteSelectedSelection: React.useCallback(() => {
            router.setParams({
                details: selectedDetailsParams.details,
                path: selectedDetailsParams.path,
                sha: selectedDetailsParams.sha,
                terminalInstanceId: selectedDetailsParams.terminalInstanceId,
            });
        }, [
            router,
            selectedDetailsParams.details,
            selectedDetailsParams.path,
            selectedDetailsParams.sha,
            selectedDetailsParams.terminalInstanceId,
        ]),
    });

    const { onRequestClose } = useFullscreenDetailsRouteController({
        resetKey: sessionId,
        enabled: Boolean(sessionId) && !cockpitEnabled,
        isFocused,
        hydrated: sessionHydrated,
        detailsIsOpen,
        hasDetails,
        keepRouteWhenEmpty: Boolean(routeDetailsState),
        keepRouteWhenDetailsClose: false,
        onDismissRoute: returnToSession,
        onCloseDetails: pane.closeDetails,
        onUnmount: cockpitEnabled ? undefined : pane.closeDetails,
    });

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
