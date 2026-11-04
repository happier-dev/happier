import * as React from 'react';
import type { Href } from 'expo-router';
import { useDestinationParams, useDestinationRouter, useDestinationFocus, useDestinationVisibility, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanelHost';
import {
    applySessionPaneUrlState,
    buildActiveDetailsRouteParams,
    createSessionPaneDetailsTab,
    parseSessionPaneUrlState,
    serializeSessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { normalizeSessionDetailsSourceSurface, resolveSessionDetailsFallbackHref } from '@/components/workspaceCockpit/session/sessionCockpitNavigation';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { usePersistSessionLastMobileSurface } from '@/sync/domains/state/storage';
import { useFullscreenDetailsRouteController } from '@/components/workspaceCockpit/useFullscreenDetailsRouteController';
import { useFullscreenDetailsRouteParamSync } from '@/components/workspaceCockpit/useFullscreenDetailsRouteParamSync';
import { usePersistSessionMobileSurface } from '@/components/workspaceCockpit/session/usePersistSessionMobileSurface';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { SessionFullscreenPaneSafeAreaView } from '@/components/sessions/panes/SessionFullscreenPaneSafeAreaView';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { SessionBoardControllerProvider } from '@/components/sessions/board/SessionBoardControllerProvider';
import { useSessionBoardPrimaryMountResolver } from '@/components/sessions/board/useSessionBoardPrimaryMountHost';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';

type SessionDetailsRouteParamsShape = Partial<ReturnType<typeof buildActiveDetailsRouteParams>> & Readonly<{ sourceSurface?: string }>;

function createDetailsRouteParamsSignature(params: SessionDetailsRouteParamsShape): string {
    const details = parseSessionPaneUrlState(params)?.details;
    return JSON.stringify([details ? serializeSessionPaneUrlState({ details }) : {}, params.sourceSurface ?? '']);
}

function ClassicSessionDetailsSurface(props: React.ComponentProps<typeof SessionDetailsPanel> & Readonly<{
    presented: boolean;
    detailsDestinationKey?: string | null;
}>) {
    const { presented, detailsDestinationKey, ...panelProps } = props;
    const address = React.useMemo(() => normalizeSessionAddress(panelProps.routeServerId, panelProps.sessionId),
        [panelProps.routeServerId, panelProps.sessionId]);
    const resolvePrimaryHost = useSessionBoardPrimaryMountResolver({
        address, paneScopeId: panelProps.scopeId, presented, detailsDestinationKey,
    });
    return <SessionBoardControllerProvider sessionId={panelProps.sessionId} serverId={panelProps.routeServerId}
        resolvePrimaryHost={resolvePrimaryHost}>
        <SessionDetailsPanel {...panelProps} resolveBoardPrimaryHost={resolvePrimaryHost} />
    </SessionBoardControllerProvider>;
}

export function SessionDetailsDestinationBody() {
    const router = useDestinationRouter();
    const persistSessionSurface = usePersistSessionLastMobileSurface();
    const isFocused = useDestinationFocus();
    const visible = useDestinationVisibility();
    const instanceKey = useDestinationInstanceKey();
    const params = useDestinationParams<{
        id: string;
        serverId?: string;
        details?: string;
        path?: string;
        sha?: string;
        terminalInstanceId?: string;
        discussionId?: string;
        sourceSurface?: string;
    }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id: sessionIdParam } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionDetailsRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const mobileExperience = useMobileWorkspaceExperienceState();
    // A phone presents Details as its Session cockpit's File scene, routed or hosted alike, so the File page
    // sits beside the cockpit's one Chat composer (phone Ask raises it over the page).
    const cockpitEnabled = mobileExperience.cockpitEnabled;
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability(routeScope.serverId);
    const scopeId = createSessionPaneScopeId(sessionId, routeScope.serverId, instanceKey);
    const pane = useAppPaneScope(scopeId);
    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
    const parsedRouteDetailsState = React.useMemo(() => parseSessionPaneUrlState(params), [params]);
    const routeDetailsState = parsedRouteDetailsState?.details ? { details: parsedRouteDetailsState.details } : null;
    const sessionAddress = normalizeSessionAddress(routeScope.serverId, sessionId);
    const destinationTab = React.useMemo(() => parsedRouteDetailsState?.details
        ? createSessionPaneDetailsTab(parsedRouteDetailsState.details, sessionAddress) : null,
    [parsedRouteDetailsState?.details, sessionAddress?.serverId, sessionAddress?.sessionId]);
    const hasDetails = detailsSelection.hasAnyDetails;
    const detailsIsOpen = detailsState?.isOpen ?? false;
    const routeDetailsParams = React.useMemo<SessionDetailsRouteParamsShape>(() => ({
        ...serializeSessionPaneUrlState(routeDetailsState ?? {}),
        sourceSurface: typeof params.sourceSurface === 'string' ? params.sourceSurface : undefined,
    }), [params]);
    const selectedDetailsParams = React.useMemo<SessionDetailsRouteParamsShape>(() => {
        const next = buildActiveDetailsRouteParams(detailsSelection.tabs, detailsSelection.activeKey, detailsState?.tabState);
        return {
            ...next,
            sourceSurface: typeof params.sourceSurface === 'string' ? params.sourceSurface : undefined,
        };
    }, [detailsSelection.activeKey, detailsSelection.tabs, detailsState?.tabState, params.sourceSurface]);
    const routeDetailsSignature = React.useMemo(
        () => createDetailsRouteParamsSignature(routeDetailsParams),
        [routeDetailsParams],
    );
    const selectedDetailsSignature = React.useMemo(
        () => createDetailsRouteParamsSignature(selectedDetailsParams),
        [selectedDetailsParams],
    );
    const fallbackDetailsHref = React.useMemo(() => resolveSessionDetailsFallbackHref({
        sessionId,
        serverId: routeScope.serverId,
        sourceSurface: params.sourceSurface,
        fallbackHref: resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId: routeScope.serverId }),
    }), [params.sourceSurface, routeScope, sessionId]);
    const retireDetailsPresentation = React.useCallback((surface: SessionMobileSurface) => {
        pane.closeDetails();
        // Retire the pane before the returning Chat mounts its web URL writer.
        if (surface === 'chat') pane.closeRight();
    }, [pane.closeDetails, pane.closeRight]);
    const returnToSession = React.useCallback(() => {
        // Responsive pane presentation replaces the Session route with Details;
        // its previous history entry need not be this Session.
        const returnSurface = normalizeSessionDetailsSourceSurface(params.sourceSurface) ?? 'chat';
        retireDetailsPresentation(returnSurface);
        persistSessionSurface(sessionId, returnSurface, routeScope.serverId);
        // The canonical Session route owner emits only registered Session hrefs.
        router.replace(fallbackDetailsHref as Href);
    }, [fallbackDetailsHref, retireDetailsPresentation, params.sourceSurface, persistSessionSurface, routeScope.serverId, router, sessionId]);
    const openDestinationTab = React.useCallback((tab: DetailsTab) => {
        const selection = buildActiveDetailsRouteParams([tab], tab.key);
        const query = new URLSearchParams();
        if (routeScope.serverId) query.set('serverId', routeScope.serverId);
        for (const [key, value] of Object.entries(selection)) {
            if (typeof value === 'string') query.set(key, value);
        }
        if (selection.details) router.push(`/session/${encodeURIComponent(sessionId)}/details?${query}`);
    }, [routeScope.serverId, router, sessionId]);

    const writeSelectedDetailsParams = React.useCallback(() => {
        router.setParams(selectedDetailsParams);
    }, [router, selectedDetailsParams]);
    useFullscreenDetailsRouteParamSync({
        resetKey: sessionId,
        // A hosted desktop destination reads its own selection; a cockpit presents the pane's. Workspace
        // navigation owns a hosted destination's URL, so there the route is only applied.
        enabled: Boolean(sessionId) && (instanceKey === null || cockpitEnabled),
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
            applySessionPaneUrlState(pane, routeDetailsState, sessionAddress);
        }, [pane, routeDetailsState, sessionAddress]),
        onWriteSelectedSelection: instanceKey === null ? writeSelectedDetailsParams : undefined,
    });

    const { onRequestClose } = useFullscreenDetailsRouteController({
        resetKey: sessionId,
        enabled: Boolean(sessionId) && !cockpitEnabled && !instanceKey,
        isFocused,
        hydrated: sessionHydrated,
        detailsIsOpen,
        hasDetails,
        keepRouteWhenEmpty: Boolean(routeDetailsState),
        keepRouteWhenDetailsClose: false,
        onDismissRoute: returnToSession,
        onCloseDetails: pane.closeDetails,
        onUnmount: cockpitEnabled || instanceKey ? undefined : pane.closeDetails,
    });

    usePersistSessionMobileSurface({
        sessionId,
        surface: cockpitEnabled ? 'tabs' : null,
        serverId: routeScope.serverId,
    });

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
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
                        surfaceFocusedOverride={isFocused}
                        surfaceVisibleOverride={visible}
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface="tabs"
                        safeAreaPadding={false}
                        terminalTabAvailable={terminalTabAvailable}
                        routeServerId={routeScope.serverId}
                        routeHydrationState={routeHydrationState}
                    />
                ) : (
                        <ClassicSessionDetailsSurface
                            sessionId={sessionId}
                            scopeId={scopeId}
                            presentation="screen"
                            routeServerId={routeHydrationState.serverId ?? routeScope.serverId}
                            presented={visible && (instanceKey !== null || isFocused)}
                            onRequestClose={instanceKey ? returnToSession : onRequestClose}
                            {...(instanceKey ? { destinationTab, destinationActive: visible,
                                detailsDestinationKey: destinationTab?.key ?? null, onOpenDestinationTab: openDestinationTab } : {})}
                        />
                )
            ) : (
                <PaneLoadingFallback />
            )}
        </SessionFullscreenPaneSafeAreaView>
    );
}
