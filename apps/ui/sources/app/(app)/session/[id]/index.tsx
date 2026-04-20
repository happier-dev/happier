import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
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
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useEndpointConnectivity, useLocalSetting, useSyncError } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';

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
    const lastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();

    const [activeServerGeneration, setActiveServerGeneration] = React.useState(() => getActiveServerSnapshot().generation);
    React.useEffect(() => {
        return subscribeActiveServer((snapshot) => {
            setActiveServerGeneration(snapshot.generation);
        });
    }, []);

    const sessionHydrated = useHydrateSessionForRoute(
        sessionId,
        `SessionRoute.ensureSessionVisible gen=${activeServerGeneration}`,
        routeScope.hydrationOptions,
    );
    const sessionCached = Boolean(storage.getState().sessions[sessionId] ?? null);
    const authRecoveryState = React.useMemo(() => {
        return resolveSessionRouteAuthRecoveryState({
            routeParams: params as Record<string, string | string[] | undefined>,
            activeServerId: getActiveServerSnapshot().serverId,
            endpointStatus: endpointConnectivity.status,
            syncError,
        });
    }, [endpointConnectivity.status, params, syncError]);
    const authRecoveryActive = Boolean(authRecoveryState.authSurfaceState);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    if (!sessionHydrated && !sessionCached && !authRecoveryActive) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="small" />
            </View>
        );
    }

    if (cockpitEnabled) {
        const surface = resolveSessionMobileSurfaceIntent({
            routeKind: 'index',
            activeRightTabId: pane.scopeState?.right?.activeTabId,
            detailsTargetPresent: (pane.scopeState?.details?.tabs?.length ?? 0) > 0,
            persistedSurface: explicitMobileSurfaceHint ?? lastMobileSurfaceBySessionId?.[sessionId] ?? null,
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
        />
    );
}
