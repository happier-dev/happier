import * as React from 'react';

import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import {
    resolveSessionSplitCanvasScope,
    type SessionSplitCanvasScope,
} from '@/sync/domains/session/sessionSplitCanvasScope';

type SessionCanvasEligibility = Readonly<{
    isCanvasEligible: boolean;
    reason: 'eligible' | 'workspace-unavailable';
    scope: SessionSplitCanvasScope | null;
}>;

export function useSessionCanvasEligibility(
    sessionId: string | null,
    options?: Readonly<{
        routeServerId?: string | null;
    }>,
): SessionCanvasEligibility {
    const workspaceTarget = useSessionWorkspaceTarget(sessionId);
    const normalizedRouteServerId = React.useMemo(() => {
        return typeof options?.routeServerId === 'string' ? options.routeServerId.trim() : '';
    }, [options?.routeServerId]);

    return React.useMemo(() => {
        const scope = resolveSessionSplitCanvasScope(workspaceTarget, {
            routeServerId: normalizedRouteServerId,
        });
        if (!scope) {
            return {
                isCanvasEligible: false,
                reason: 'workspace-unavailable' as const,
                scope: null,
            };
        }

        return {
            isCanvasEligible: true,
            reason: 'eligible' as const,
            scope,
        };
    }, [normalizedRouteServerId, workspaceTarget]);
}
