import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionCockpitShell } from '@/components/workspaceCockpit/session/SessionCockpitShell';
import { resolveSessionMobileSurfaceIntent } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { getTempData } from '@/utils/sessions/tempDataStore';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useLocalSetting } from '@/sync/domains/state/storage';

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
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
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
    const recoverableAttachmentDrafts = React.useMemo(() => {
        const trimmedRecoveryDataId = recoveryDataId.trim();
        if (!trimmedRecoveryDataId) {
            return null;
        }

        const data = getTempData<{ attachmentDrafts?: readonly AttachmentDraft[] | null }>(trimmedRecoveryDataId);
        return Array.isArray(data?.attachmentDrafts) ? data.attachmentDrafts : null;
    }, [recoveryDataId]);
    const paneUrlState = React.useMemo(() => parseSessionPaneUrlState(params as any), [params]);
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const lastMobileSurfaceBySessionId = useLocalSetting('sessionLastMobileSurfaceBySessionId');
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability({
        sessionId,
        serverId: routeScope.serverId ?? null,
    });

    const activeServerGeneration = useActiveServerSnapshot().generation;

    const sessionHydrated = useHydrateSessionForRoute(
        sessionId,
        `SessionRoute.ensureSessionVisible gen=${activeServerGeneration}`,
        routeScope.hydrationOptions,
    );

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
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
                routeServerId={routeScope.serverId ?? undefined}
                jumpToSeq={jumpToSeq}
                paneUrlState={paneUrlState ?? undefined}
                initialAttachmentDrafts={recoverableAttachmentDrafts}
                terminalTabAvailable={terminalTabAvailable}
            />
        );
    }

    return (
        <SessionView
            id={sessionId}
            routeServerId={routeScope.serverId ?? undefined}
            jumpToSeq={jumpToSeq}
            paneUrlState={paneUrlState ?? undefined}
            initialAttachmentDrafts={recoverableAttachmentDrafts}
        />
    );
});
