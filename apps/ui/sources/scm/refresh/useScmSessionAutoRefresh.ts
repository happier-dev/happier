import * as React from 'react';

import { scmStatusSync } from '@/scm/scmStatusSync';
import { followSignal, useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';

/**
 * Visible demand for the repository's shared external-editor fallback.
 * The SCM owner combines composer, Git and Review demand into one adaptive poll.
 */
export function useScmSessionAutoRefresh(params: Readonly<{
    sessionId: string | null | undefined;
    serverId?: string | null;
    intervalMs: number;
    stepIntervalMs?: number;
    maxIntervalMs?: number;
    enabled?: boolean;
}>): void {
    const { sessionId, serverId, intervalMs, stepIntervalMs, maxIntervalMs, enabled = true } = params;
    // Presentation only starts and stops the demand: followed by subscription, so a hide or show does
    // not render the host.
    const presentation = useLayoutPresentationSignal();
    // Target hydration can settle after the visible Session mounts, without changing its demand.
    const targetKey = useWorkspaceScopeForSession(enabled ? sessionId : null, serverId)?.workspaceCacheKey;

    React.useEffect(() => {
        if (!sessionId || !enabled) return undefined;
        return followSignal(presentation, (presented) => presented
            ? scmStatusSync.retainAutoRefresh({ sessionId, serverId, intervalMs, stepIntervalMs, maxIntervalMs })
            : undefined);
    }, [enabled, presentation, intervalMs, stepIntervalMs, maxIntervalMs, serverId, sessionId, targetKey]);
}
