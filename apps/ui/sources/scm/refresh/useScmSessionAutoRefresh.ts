import * as React from 'react';

import { scmStatusSync } from '@/scm/scmStatusSync';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

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
    const presented = useLayoutPresentationActive();

    React.useEffect(() => {
        if (!sessionId || !enabled || !presented) return undefined;
        return scmStatusSync.retainAutoRefresh({ sessionId, serverId, intervalMs, stepIntervalMs, maxIntervalMs });
    }, [enabled, presented, intervalMs, stepIntervalMs, maxIntervalMs, serverId, sessionId]);
}
