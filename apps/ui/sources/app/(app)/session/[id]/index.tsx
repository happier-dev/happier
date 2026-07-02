import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionSplitCanvasScreen } from '@/components/sessions/canvas/SessionSplitCanvasScreen';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { resolveSessionMobileSurfaceIntent } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { getTempData } from '@/utils/sessions/tempDataStore';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { resolveSessionRouteAuthRecoveryState } from '@/hooks/session/sessionRouteAuthRecovery';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationPending } from '@/sync/domains/session/sessionRouteHydrationState';
import { useEndpointConnectivity, useSyncError } from '@/sync/domains/state/storage';
import { markSessionRouteEnteredForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { normalizeSessionListKeyParts } from '@/sync/domains/session/listing/sessionListKeyNormalization';

type InitialMobileSurfaceHintCache = Readonly<{
    sessionId: string;
    routeServerId: string | null;
    explicitMobileSurfaceHint: string | null;
    persistedSurface: string | null;
}>;

function readPersistedMobileSurfaceSnapshot(sessionId: string, routeServerId: string | null): string | null {
    const persistedBySessionId = storage.getState().localSettings.sessionLastMobileSurfaceBySessionId;
    const scopedStorageKey = normalizeSessionListKeyParts(routeServerId, sessionId).sessionKey;
    const scopedValue = scopedStorageKey ? persistedBySessionId?.[scopedStorageKey] ?? null : null;
    if (typeof scopedValue === 'string') {
        return scopedValue;
    }
    const legacyValue = persistedBySessionId?.[sessionId] ?? null;
    return typeof legacyValue === 'string' ? legacyValue : null;
}

function useInitialMobileSurfaceHint(
    sessionId: string,
    routeServerId: string | null,
    explicitMobileSurfaceHint: string | null,
): string | null {
    const cacheRef = React.useRef<InitialMobileSurfaceHintCache | null>(null);
    const cached = cacheRef.current;
    if (
        !cached
        || cached.sessionId !== sessionId
        || cached.routeServerId !== routeServerId
        || cached.explicitMobileSurfaceHint !== explicitMobileSurfaceHint
    ) {
        cacheRef.current = {
            sessionId,
            routeServerId,
            explicitMobileSurfaceHint,
            persistedSurface: explicitMobileSurfaceHint ?? (
                sessionId
                    ? readPersistedMobileSurfaceSnapshot(sessionId, routeServerId)
                    : null
            ),
        };
    }
    return cacheRef.current?.persistedSurface ?? null;
}

export default function SessionRouteIndex() {
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
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const {
        id: sessionIdParam,
        serverId: serverIdParam,
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
    const jumpToSeq = Number.isFinite(jumpSeqNum) && jumpSeqNum >= 0 ? Math.trunc(jumpSeqNum) : null;
    const routeServerId = typeof serverIdParam === 'string'
        ? serverIdParam
        : Array.isArray(serverIdParam)
            ? (serverIdParam[0] ?? '')
            : '';
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
    const paneUrlState = React.useMemo(() => parseSessionPaneUrlState(params as any), [params]);
    const scopeId = `session:${sessionId}`;
    const pane = useAppPaneScope(scopeId);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const initialMobileSurfaceHint = useInitialMobileSurfaceHint(sessionId, routeServerId.trim() || null, explicitMobileSurfaceHint);
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability();
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
    const sessionCached = Boolean(storage.getState().sessions[sessionId] ?? null);
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
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner size="small" />
            </View>
        );
    }

    if (cockpitEnabled) {
        const surface = resolveSessionMobileSurfaceIntent({
            routeKind: 'index',
            activeRightTabId: pane.scopeState?.right?.activeTabId,
            detailsTargetPresent: (pane.scopeState?.details?.tabs?.length ?? 0) > 0,
            persistedSurface: initialMobileSurfaceHint,
            terminalTabAvailable,
        });
        return (
            <SessionCockpitShell
                sessionId={sessionId}
                scopeId={scopeId}
                surface={surface}
                jumpToSeq={jumpToSeq}
                paneUrlState={paneUrlState ?? undefined}
                initialAttachmentDrafts={recoverableAttachmentDrafts}
                terminalTabAvailable={terminalTabAvailable}
                routeServerId={routeServerId.trim() || undefined}
                routeHydrationState={routeHydrationState}
            />
        );
    }

    return (
        <SessionSplitCanvasScreen
            sessionId={sessionId}
            routeServerId={routeServerId.trim() || undefined}
            jumpToSeq={jumpToSeq}
            paneUrlState={paneUrlState ?? undefined}
            initialAttachmentDrafts={recoverableAttachmentDrafts}
            routeHydrationState={routeHydrationState}
        />
    );
}
