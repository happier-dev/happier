import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import { SessionFullscreenPaneSafeAreaView } from '@/components/sessions/panes/SessionFullscreenPaneSafeAreaView';
import {
    applySessionPaneUrlState,
    buildActiveDetailsRouteParams,
    parseSessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { resolveSessionDetailsFallbackHref } from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteController } from '@/components/workspaceCockpit/useFullscreenDetailsRouteController';
import { useFullscreenDetailsRouteParamSync } from '@/components/workspaceCockpit/useFullscreenDetailsRouteParamSync';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';

type SessionDetailsRouteParamsShape = Readonly<{
    details?: string;
    path?: string;
    sha?: string;
    terminalInstanceId?: string;
    sourceSurface?: string;
}>;

function createDetailsRouteParamsSignature(params: SessionDetailsRouteParamsShape): string {
    return [
        params.details ?? '',
        params.path ?? '',
        params.sha ?? '',
        params.terminalInstanceId ?? '',
        params.sourceSurface ?? '',
    ].join('|');
}

export default function SessionDetailsScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; serverId?: string; details?: string; path?: string; sha?: string; terminalInstanceId?: string; sourceSurface?: string }>();
    const { id: sessionIdParam } = params;
    const sessionId = String(sessionIdParam ?? '').trim();
    const routeScope = useSessionRouteServerScope(params);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionDetailsRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const scopeId = React.useMemo(() => resolveSessionPaneScopeId(sessionId), [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
    }), [detailsState?.activeTabKey, detailsState?.tabs]);
    const parsedRouteDetailsState = parseSessionPaneUrlState(params as Record<string, unknown>);
    const routeDetailsState = parsedRouteDetailsState?.details ? { details: parsedRouteDetailsState.details } : null;
    const hasDetails = detailsSelection.hasAnyDetails;
    const detailsIsOpen = detailsState?.isOpen ?? false;
    const routeDetailsParams = React.useMemo<SessionDetailsRouteParamsShape>(() => ({
        details: typeof params.details === 'string' ? params.details : undefined,
        path: typeof params.path === 'string' ? params.path : undefined,
        sha: typeof params.sha === 'string' ? params.sha : undefined,
        terminalInstanceId: typeof params.terminalInstanceId === 'string' ? params.terminalInstanceId : undefined,
        sourceSurface: typeof params.sourceSurface === 'string' ? params.sourceSurface : undefined,
    }), [params]);
    const selectedDetailsParams = React.useMemo<SessionDetailsRouteParamsShape>(() => {
        const next = buildActiveDetailsRouteParams(detailsSelection.tabs, detailsSelection.activeKey);
        return {
            details: next.details,
            path: next.path,
            sha: next.sha,
            terminalInstanceId: next.terminalInstanceId,
            sourceSurface: typeof params.sourceSurface === 'string' ? params.sourceSurface : undefined,
        };
    }, [detailsSelection.activeKey, detailsSelection.tabs, params.sourceSurface]);
    const routeDetailsSignature = React.useMemo(
        () => createDetailsRouteParamsSignature(routeDetailsParams),
        [routeDetailsParams],
    );
    const selectedDetailsSignature = React.useMemo(
        () => createDetailsRouteParamsSignature(selectedDetailsParams),
        [selectedDetailsParams],
    );
    const fallbackSessionHref = routeScope.buildHref(sessionId);
    const fallbackDetailsHref = resolveSessionDetailsFallbackHref({
        sessionId,
        serverId: routeScope.serverId,
        sourceSurface: params.sourceSurface,
        fallbackHref: fallbackSessionHref,
    });
    const replaceWithSession = React.useCallback(() => {
        router.replace(fallbackDetailsHref);
    }, [fallbackDetailsHref, router]);
    const returnToSession = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: fallbackDetailsHref });
    }, [fallbackDetailsHref, navigation, router]);

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
            if (!routeDetailsState) return;
            applySessionPaneUrlState(pane, routeDetailsState);
        }, [pane, routeDetailsState]),
        onWriteSelectedSelection: React.useCallback(() => {
            router.setParams({
                details: selectedDetailsParams.details,
                path: selectedDetailsParams.path,
                sha: selectedDetailsParams.sha,
                terminalInstanceId: selectedDetailsParams.terminalInstanceId,
                sourceSurface: selectedDetailsParams.sourceSurface,
            });
        }, [
            router,
            selectedDetailsParams.details,
            selectedDetailsParams.path,
            selectedDetailsParams.sha,
            selectedDetailsParams.terminalInstanceId,
            selectedDetailsParams.sourceSurface,
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
        onDismissRoute: replaceWithSession,
        onRequestCloseRoute: returnToSession,
        onCloseDetails: pane.closeDetails,
        onUnmount: cockpitEnabled ? undefined : pane.closeDetails,
    });

    usePersistSessionMobileSurface({
        sessionId,
        surface: cockpitEnabled ? 'tabs' : null,
        enabled: isFocused,
    });

    if (!sessionId || sessionMissingAfterHydration) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <SessionFullscreenPaneSafeAreaView
            testID={cockpitEnabled ? 'session-cockpit-route-screen' : 'session-details-screen'}
            includeTopInset={!cockpitEnabled}
        >
            {sessionHydrated ? (
                cockpitEnabled ? (
                    <SessionCockpitShell
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface="tabs"
                        routeServerId={routeScope.serverId ?? undefined}
                        routeHydrationState={routeHydrationState}
                        safeAreaPadding={false}
                    />
                ) : (
                    <SessionDetailsPanel sessionId={sessionId} scopeId={scopeId} presentation="screen" onRequestClose={onRequestClose} />
                )
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner />
                </View>
            )}
        </SessionFullscreenPaneSafeAreaView>
    );
}
