import * as React from 'react';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import {
    clearFocusedSessionId,
    clearRouteAnchorSessionId,
    getSessionSurfaceVisibilityResetVersion,
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    setFocusedSessionId,
    setRouteAnchorSessionId,
    subscribeSessionSurfaceVisibilityReset,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { registerSessionTranscriptRetentionConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useOptionalWorkspaceNavigation, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

export type UseSessionSurfaceActivationInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    onSessionVisible?: (sessionId: string) => void;
    surfaceFocused: boolean;
    /**
     * Whether this mounted surface is still part of the user-reachable surface set.
     * Defaults to true so hidden native back-stack screens remain protected while
     * web route hosts can release mounted historical routes after SPA navigation.
     */
    surfaceRetained?: boolean;
    surfaceVisible: boolean;
    routeAnchor: boolean;
}>;

export type UseSessionSurfaceActivationResult = Readonly<{
    isSurfaceFocused: boolean;
    isVisible: boolean;
}>;

const selectHasWorkspace = (value: WorkspaceNavigationContextValue | null) => value !== null;

export function useSessionSurfaceActivation(
    input: UseSessionSurfaceActivationInput,
): UseSessionSurfaceActivationResult {
    const normalizedSessionId = normalizeSessionId(input.sessionId);
    const workspaceOwnsRouteAnchor = useOptionalWorkspaceNavigation(selectHasWorkspace);
    const visibilityResetVersion = React.useSyncExternalStore(
        subscribeSessionSurfaceVisibilityReset,
        getSessionSurfaceVisibilityResetVersion,
        getSessionSurfaceVisibilityResetVersion,
    );

    React.useLayoutEffect(() => {
        if (!normalizedSessionId) return;
        if (!input.surfaceVisible) {
            return;
        }
        markSessionSurfaceVisible(normalizedSessionId, input.serverId);
        input.onSessionVisible?.(normalizedSessionId);
        return () => {
            markSessionSurfaceHidden(normalizedSessionId, input.serverId);
        };
    }, [
        input.onSessionVisible,
        input.serverId,
        input.surfaceVisible,
        normalizedSessionId,
        visibilityResetVersion,
    ]);

    React.useLayoutEffect(() => {
        if (!normalizedSessionId) return;
        if (!input.surfaceVisible || !input.surfaceFocused) {
            return;
        }
        setFocusedSessionId(normalizedSessionId, input.serverId);
        const address = normalizeSessionAddress(
            input.serverId ?? getActiveServerSnapshot().serverId,
            normalizedSessionId,
        );
        if (address) useVoiceTargetStore.getState().setLastFocusedSessionAddress(address);
        return () => {
            clearFocusedSessionId(normalizedSessionId, input.serverId);
        };
    }, [
        input.surfaceFocused,
        input.serverId,
        input.surfaceVisible,
        normalizedSessionId,
        visibilityResetVersion,
    ]);

    // Transcript retention hold (NOT gated on surfaceVisible by default): a
    // hidden-but-mounted back-stack SessionView still renders its transcript, so the
    // eviction sweep must treat it as a retained consumer until real unmount. Web
    // route hosts pass surfaceRetained=false when a mounted route is no longer displayed.
    React.useEffect(() => {
        if (!normalizedSessionId || input.surfaceRetained === false) return;
        return registerSessionTranscriptRetentionConsumer(normalizedSessionId, input.serverId);
    }, [input.serverId, input.surfaceRetained, normalizedSessionId]);

    React.useLayoutEffect(() => {
        if (!normalizedSessionId) return;
        if (!input.routeAnchor || workspaceOwnsRouteAnchor) {
            return;
        }
        // Standalone/onboarding surfaces have no workspace route owner.
        setRouteAnchorSessionId(normalizedSessionId, input.serverId);
        return () => {
            clearRouteAnchorSessionId(normalizedSessionId);
        };
    }, [input.routeAnchor, input.serverId, normalizedSessionId, visibilityResetVersion, workspaceOwnsRouteAnchor]);

    const hasSessionId = normalizedSessionId.length > 0;

    return React.useMemo(() => ({
        isSurfaceFocused: hasSessionId && input.surfaceVisible && input.surfaceFocused,
        isVisible: hasSessionId && input.surfaceVisible,
    }), [hasSessionId, input.surfaceFocused, input.surfaceVisible]);
}
