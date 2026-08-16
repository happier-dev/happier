import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Platform, View } from 'react-native';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { TranscriptSameSessionHandoffProvider } from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { selectSessionViewShellSessionForRouteState } from '@/components/sessions/shell/sessionViewStableSession';
import { resolveSessionMobileSurfaceIntent } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { getTempData } from '@/utils/sessions/tempDataStore';
import { resolveSessionRouteAuthRecoveryState } from '@/hooks/session/sessionRouteAuthRecovery';
import { useSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { markSessionRouteEnteredForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import {
    isSessionRouteHydrationAvailable,
    isSessionRouteHydrationPending,
} from '@/sync/domains/session/sessionRouteHydrationState';
import {
    getStorage,
    readSessionLastMobileSurfaceFromMap,
    storage,
    useEndpointConnectivity,
    useSyncError,
} from '@/sync/domains/state/storage';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

type InitialMobileSurfaceHintCache = Readonly<{
    sessionId: string;
    serverId: string | null;
    explicitMobileSurfaceHint: string | null;
    persistedSurface: string | null;
}>;

function readPersistedMobileSurfaceSnapshot(sessionId: string, serverId: string | null): string | null {
    return readSessionLastMobileSurfaceFromMap(
        getStorage().getState().localSettings.sessionLastMobileSurfaceBySessionId,
        {
            sessionId,
            explicitServerId: serverId,
        },
    );
}

function useInitialMobileSurfaceHint(
    sessionId: string,
    explicitMobileSurfaceHint: string | null,
    serverId: string | null,
): string | null {
    const cacheRef = React.useRef<InitialMobileSurfaceHintCache | null>(null);
    const cached = cacheRef.current;

    if (
        !cached
        || cached.sessionId !== sessionId
        || cached.serverId !== serverId
        || cached.explicitMobileSurfaceHint !== explicitMobileSurfaceHint
    ) {
        cacheRef.current = {
            sessionId,
            serverId,
            explicitMobileSurfaceHint,
            persistedSurface: explicitMobileSurfaceHint ?? (
                sessionId ? readPersistedMobileSurfaceSnapshot(sessionId, serverId) : null
            ),
        };
    }

    return cacheRef.current?.persistedSurface ?? null;
}

export default React.memo(() => {
    const params = useLocalSearchParams<{
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
    const routeScope = useSessionRouteServerScope(params as Record<string, unknown>);
    const {
        id: sessionIdParam,
        mobileSurface: mobileSurfaceParam,
        jumpSeq: jumpSeqParam,
        recoveryDataId: recoveryDataIdParam,
    } = params;
    const sessionId =
        (typeof sessionIdParam === 'string'
            ? sessionIdParam
            : Array.isArray(sessionIdParam)
                ? (sessionIdParam[0] ?? '')
                : '').trim();
    const jumpSeqRaw = typeof jumpSeqParam === 'string'
        ? jumpSeqParam
        : Array.isArray(jumpSeqParam)
            ? (jumpSeqParam[0] ?? null)
            : null;
    const jumpSeqTrimmed = typeof jumpSeqRaw === 'string' ? jumpSeqRaw.trim() : '';
    const jumpSeqNum = jumpSeqTrimmed.length > 0 ? Number(jumpSeqTrimmed) : NaN;
    const jumpToSeq = Number.isFinite(jumpSeqNum) && jumpSeqNum >= 0 ? Math.trunc(jumpSeqNum) : null;
    const recoveryDataId = typeof recoveryDataIdParam === 'string'
        ? recoveryDataIdParam
        : Array.isArray(recoveryDataIdParam)
            ? (recoveryDataIdParam[0] ?? '')
            : '';
    const explicitMobileSurfaceHint = typeof mobileSurfaceParam === 'string'
        ? mobileSurfaceParam
        : Array.isArray(mobileSurfaceParam)
            ? (mobileSurfaceParam[0] ?? null)
            : null;
    const initialMobileSurfaceHint = useInitialMobileSurfaceHint(
        sessionId,
        explicitMobileSurfaceHint,
        routeScope.serverId ?? null,
    );
    const recoverableAttachmentDrafts = React.useMemo(() => {
        const trimmedRecoveryDataId = recoveryDataId.trim();
        if (!trimmedRecoveryDataId) {
            return null;
        }

        const data = getTempData<{ attachmentDrafts?: readonly AttachmentDraft[] | null }>(trimmedRecoveryDataId);
        return Array.isArray(data?.attachmentDrafts) ? data.attachmentDrafts : null;
    }, [recoveryDataId]);
    const paneUrlState = React.useMemo(() => parseSessionPaneUrlState(params as any), [params]);
    const scopeId = React.useMemo(() => resolveSessionPaneScopeId(sessionId), [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability({
        sessionId,
        serverId: routeScope.serverId ?? null,
    });

    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const activeServerSnapshot = useActiveServerSnapshot();
    const activeServerGeneration = activeServerSnapshot.generation;

    React.useLayoutEffect(() => {
        markSessionRouteEnteredForSessionUiTelemetry({ sessionId });
    }, [sessionId]);

    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        `SessionRoute.ensureSessionVisible gen=${activeServerGeneration}`,
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionCached = storage((state) => {
        return Boolean(selectSessionViewShellSessionForRouteState(
            {
                sessions: state.sessions,
                sessionListViewDataByServerId: state.sessionListViewDataByServerId,
            },
            sessionId,
            routeHydrationState.serverId ?? routeScope.serverId ?? null,
        ));
    });
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

    if (isSessionRouteHydrationPending(routeHydrationState) && !sessionCached && !authRecoveryActive) {
        return (
            <View testID="session-route-loading" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner size="small" />
            </View>
        );
    }

    return (
        <TranscriptSameSessionHandoffProvider
            desiredExperience={cockpitEnabled ? 'cockpit' : 'classic'}
            sessionId={sessionId}
        >
            {(experience) => experience === 'cockpit'
                ? (
                    <SessionCockpitShell
                        sessionId={sessionId}
                        scopeId={scopeId}
                        surface={resolveSessionMobileSurfaceIntent({
                            routeKind: 'index',
                            activeRightTabId: pane.scopeState?.right?.activeTabId,
                            detailsTargetPresent: (pane.scopeState?.details?.tabs?.length ?? 0) > 0,
                            persistedSurface: initialMobileSurfaceHint,
                            terminalTabAvailable,
                        })}
                        routeServerId={routeScope.serverId ?? undefined}
                        jumpToSeq={jumpToSeq}
                        paneUrlState={paneUrlState ?? undefined}
                        initialAttachmentDrafts={recoverableAttachmentDrafts}
                        routeHydrationState={routeHydrationState}
                        terminalTabAvailable={terminalTabAvailable}
                    />
                )
                : (
                    <SessionView
                        id={sessionId}
                        routeServerId={routeScope.serverId ?? undefined}
                        jumpToSeq={jumpToSeq}
                        paneUrlState={paneUrlState ?? undefined}
                        initialAttachmentDrafts={recoverableAttachmentDrafts}
                        routeAnchorOverride={Platform.OS === 'web' ? undefined : true}
                        routeHydrationState={routeHydrationState}
                    />
                )}
        </TranscriptSameSessionHandoffProvider>
    );
});
