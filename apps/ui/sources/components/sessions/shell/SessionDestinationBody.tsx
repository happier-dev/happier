import * as React from 'react';
import { useDestinationParams, useDestinationFocus, useDestinationVisibility, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import type { PaneScopeState } from '@/components/appShell/panes/model/appPaneReducer';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { TranscriptSameSessionHandoffProvider } from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import {
    resolveSessionMobileSurfaceIntent,
    shouldUseSessionCockpitExperience,
} from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { getTempData } from '@/utils/sessions/tempDataStore';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { resolveSessionRouteAuthRecoveryState } from '@/hooks/session/sessionRouteAuthRecovery';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import {
    useActiveServerAccountScope,
    useEndpointConnectivity,
    useSessionLastMobileSurface,
    useSyncError,
} from '@/sync/domains/state/storage';
import { markSessionRouteEnteredForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { AtmosphereSurfaceFrame } from '@/components/atmosphere/AtmosphereSurfaceFrame';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { selectSessionViewShellSessionForRouteState } from '@/components/sessions/shell/sessionViewStableSession';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

type InitialMobileSurfaceHintCache = Readonly<{
    sessionId: string;
    routeServerId: string | null;
    activeServerId: string | null;
    activeScopeKey: string | null;
    explicitMobileSurfaceHint: string | null;
    persistedSurface: string | null;
}>;

function useInitialMobileSurfaceHint(
    sessionId: string,
    routeServerId: string | null,
    explicitMobileSurfaceHint: string | null,
    activeServerId: string | null,
    activeScope: ServerAccountScope | null,
    persistedMobileSurface: string | null,
): string | null {
    const cacheRef = React.useRef<InitialMobileSurfaceHintCache | null>(null);
    const cached = cacheRef.current;
    const activeScopeKey = activeScope ? serverAccountScopeKeySuffix(activeScope) : null;
    if (
        !cached
        || cached.sessionId !== sessionId
        || cached.routeServerId !== routeServerId
        || cached.activeServerId !== activeServerId
        || cached.activeScopeKey !== activeScopeKey
        || cached.explicitMobileSurfaceHint !== explicitMobileSurfaceHint
    ) {
        cacheRef.current = {
            sessionId,
            routeServerId,
            activeServerId,
            activeScopeKey,
            explicitMobileSurfaceHint,
            // The storage hook is the only session-selection reader/migrator.
            // Keep this route cache's incumbent snapshot behavior so a live
            // setting write cannot remount the currently focused cockpit tab.
            persistedSurface: explicitMobileSurfaceHint ?? persistedMobileSurface,
        };
    }
    return cacheRef.current?.persistedSurface ?? null;
}


/** The two pane facts that choose the phone surface; the rest of the pane (a side tab's state, sizes) is not read here. */
const selectSessionSurfaceFacts = (scope: PaneScopeState | null) => ({
    activeRightTabId: scope?.right?.activeTabId,
    detailsTargetPresent: scope ? buildDetailsWorkspaceStateView(scope.details).tabs.length > 0 : false,
});

/** Focus and visibility are read here, in the leaf that draws them: a tab switch does not render the body. */
function SessionLoadingAtmosphere(props: Readonly<{ address: SessionAddress }>) {
    const focused = useDestinationFocus();
    const visible = useDestinationVisibility();
    return <AtmosphereSurfaceFrame surface={{ session: props.address }} session focused={focused} visible={visible}>
        <PaneLoadingFallback />
    </AtmosphereSurfaceFrame>;
}

export function SessionDestinationBody(props: Readonly<{
    messageTarget?: Readonly<{ routeMessageId: string; seq: number }>;
}> = {}) {
    const instanceKey = useDestinationInstanceKey();
    const params = useDestinationParams<{
        id?: string | string[];
        serverId?: string | string[];
        mobileSurface?: string | string[];
        jumpSeq?: string | string[];
        right?: string | string[];
        bottom?: string | string[];
        details?: string | string[];
        path?: string | string[];
        sha?: string | string[];
        recoveryDataId?: string | string[];
    }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const {
        id: sessionIdParam,
        mobileSurface: mobileSurfaceParam,
        jumpSeq: jumpSeqParam,
        recoveryDataId: recoveryDataIdParam,
    } = params;
    const sessionId = normalizeSessionId(sessionIdParam);
    const explicitMobileSurfaceHint = typeof mobileSurfaceParam === 'string'
        ? mobileSurfaceParam
        : Array.isArray(mobileSurfaceParam)
            ? (mobileSurfaceParam[0] ?? null)
            : null;
    const jumpSeqRaw = typeof jumpSeqParam === 'string'
        ? jumpSeqParam
        : Array.isArray(jumpSeqParam)
            ? (jumpSeqParam[0] ?? null)
            : null;
    const jumpSeqTrimmed = typeof jumpSeqRaw === 'string' ? jumpSeqRaw.trim() : '';
    const jumpSeqNum = jumpSeqTrimmed.length > 0 ? Number(jumpSeqTrimmed) : NaN;
    const jumpToSeq = props.messageTarget?.seq ?? (Number.isFinite(jumpSeqNum) && jumpSeqNum >= 0 ? Math.trunc(jumpSeqNum) : null);
    const routeServerId = routeScope.serverId ?? '';
    const recoveryDataId = typeof recoveryDataIdParam === 'string'
        ? recoveryDataIdParam
        : Array.isArray(recoveryDataIdParam)
            ? (recoveryDataIdParam[0] ?? '')
            : '';
    const recoverableAttachmentDrafts = React.useMemo(() => {
        const trimmedRecoveryDataId = recoveryDataId.trim();
        if (!trimmedRecoveryDataId) {
            return null;
        }

        const data = getTempData<{ attachmentDrafts?: readonly AttachmentDraft[] | null }>(trimmedRecoveryDataId);
        return Array.isArray(data?.attachmentDrafts) ? data.attachmentDrafts : null;
    }, [recoveryDataId]);
    const scopeId = createSessionPaneScopeId(sessionId, routeScope.serverId, instanceKey);
    const { scopeState: surfaceFacts } = useAppPaneScope(scopeId, selectSessionSurfaceFacts);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const activeServerAccountScope = useActiveServerAccountScope();
    const activeServerSnapshot = useActiveServerSnapshot();
    const persistedMobileSurface = useSessionLastMobileSurface(
        sessionId || null,
        routeServerId.trim() || null,
    );
    const initialMobileSurfaceHint = useInitialMobileSurfaceHint(
        sessionId,
        routeServerId.trim() || null,
        explicitMobileSurfaceHint,
        activeServerSnapshot.serverId,
        activeServerAccountScope,
        persistedMobileSurface,
    );
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability(routeScope.serverId);
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();

    const activeServerGeneration = activeServerSnapshot.generation;

    React.useLayoutEffect(() => {
        markSessionRouteEnteredForSessionUiTelemetry({ sessionId });
    }, [sessionId]);

    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        `SessionRoute.ensureSessionVisible gen=${activeServerGeneration}`,
        routeScope.hydrationOptions,
    );
    const expectedSessionServerId = routeHydrationState.serverId ?? routeScope.serverId;
    const routeSessionAddress = normalizeSessionAddress(
        expectedSessionServerId ?? activeServerSnapshot.serverId,
        sessionId,
    );
    const sessionSurfaceKey = routeSessionAddress ? sessionAddressKey(routeSessionAddress) : null;
    // Companion has no feature of its own, so a Companion route hint claims the
    // Cockpit experience as soon as the route resolves to an exact Session
    // address; the Board content it presents stays behind `sessions.board`.
    const useCockpitExperience = shouldUseSessionCockpitExperience({
        cockpitEnabled,
        explicitSurface: explicitMobileSurfaceHint,
        companionAddressQualified: routeSessionAddress !== null,
    });
    const sessionCached = storage((state) => Boolean(selectSessionViewShellSessionForRouteState(
        {
            sessions: state.sessions,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
        },
        sessionId,
        expectedSessionServerId,
    )));
    const authRecoveryState = React.useMemo(() => {
        return resolveSessionRouteAuthRecoveryState({
            routeParams: params as Record<string, string | string[] | undefined>,
            activeServerId: activeServerSnapshot.serverId,
            endpointStatus: endpointConnectivity.status,
            syncError,
        });
    }, [activeServerSnapshot.serverId, endpointConnectivity.status, params, syncError]);
    const authRecoveryActive = Boolean(authRecoveryState.authSurfaceState);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    if (routeSessionAddress === null || sessionSurfaceKey === null) {
        return <SessionInvalidLinkFallback />;
    }

    if (routeHydrationState.kind === 'loading' && !sessionCached && !authRecoveryActive) {
        // The route already supplies the atmosphere's address; Session detail is not a paint prerequisite.
        return <SessionLoadingAtmosphere address={routeSessionAddress} />;
    }

    return (
        <TranscriptSameSessionHandoffProvider
            desiredExperience={useCockpitExperience ? 'cockpit' : 'classic'}
            sessionAddressKey={sessionSurfaceKey}
        >
            {(experience) => (
                    <SessionCockpitShell
                        experience={experience}
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface={resolveSessionMobileSurfaceIntent({
                            routeKind: 'index',
                            activeRightTabId: surfaceFacts.activeRightTabId,
                            detailsTargetPresent: surfaceFacts.detailsTargetPresent,
                            persistedSurface: props.messageTarget ? 'chat' : initialMobileSurfaceHint,
                            terminalTabAvailable,
                        })}
                        jumpToSeq={jumpToSeq}
                        jumpToMessageId={props.messageTarget?.routeMessageId}
                        initialAttachmentDrafts={recoverableAttachmentDrafts}
                        terminalTabAvailable={terminalTabAvailable}
                        routeServerId={routeServerId.trim() || undefined}
                        routeHydrationState={routeHydrationState}
                    />
                )}
        </TranscriptSameSessionHandoffProvider>
    );
}
