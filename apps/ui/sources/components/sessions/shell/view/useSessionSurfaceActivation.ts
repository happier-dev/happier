import * as React from 'react';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import {
    clearFocusedSessionId,
    clearRouteAnchorSessionId,
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    setFocusedSessionId,
    setRouteAnchorSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

export type UseSessionSurfaceActivationInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    surfaceFocused: boolean;
    surfaceVisible: boolean;
    routeAnchor: boolean;
}>;

export type UseSessionSurfaceActivationResult = Readonly<{
    isSurfaceFocused: boolean;
    isVisible: boolean;
}>;

export function useSessionSurfaceActivation(
    input: UseSessionSurfaceActivationInput,
): UseSessionSurfaceActivationResult {
    const normalizedSessionId = normalizeSessionId(input.sessionId);

    React.useLayoutEffect(() => {
        if (!normalizedSessionId) return;
        if (!input.surfaceVisible) {
            return;
        }
        markSessionSurfaceVisible(normalizedSessionId, input.serverId);
        return () => {
            markSessionSurfaceHidden(normalizedSessionId, input.serverId);
        };
    }, [input.serverId, input.surfaceVisible, normalizedSessionId]);

    React.useLayoutEffect(() => {
        if (!normalizedSessionId) return;
        if (!input.surfaceVisible || !input.surfaceFocused) {
            clearFocusedSessionId(normalizedSessionId);
            return;
        }
        setFocusedSessionId(normalizedSessionId);
        useVoiceTargetStore.getState().setLastFocusedSessionId(normalizedSessionId);
        return () => {
            clearFocusedSessionId(normalizedSessionId);
        };
    }, [input.surfaceFocused, input.surfaceVisible, normalizedSessionId]);

    React.useLayoutEffect(() => {
        if (!normalizedSessionId) return;
        if (!input.routeAnchor) {
            clearRouteAnchorSessionId(normalizedSessionId);
            return;
        }
        setRouteAnchorSessionId(normalizedSessionId);
        return () => {
            clearRouteAnchorSessionId(normalizedSessionId);
        };
    }, [input.routeAnchor, normalizedSessionId]);

    const hasSessionId = normalizedSessionId.length > 0;

    return React.useMemo(() => ({
        isSurfaceFocused: hasSessionId && input.surfaceVisible && input.surfaceFocused,
        isVisible: hasSessionId && input.surfaceVisible,
    }), [hasSessionId, input.surfaceFocused, input.surfaceVisible]);
}
