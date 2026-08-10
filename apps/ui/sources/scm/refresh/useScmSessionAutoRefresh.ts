import * as React from 'react';

import { scmStatusSync } from '@/scm/scmStatusSync';
import { startRuntimeActiveGatedInterval } from '@/utils/runtime/isRuntimeActive';

/**
 * Screen-scoped SCM auto-refresh: keeps a session's status badge reasonably
 * up-to-date without noisy polling.
 *
 * Each refresh is a round trip to the daemon that makes the *machine* run git,
 * so it runs only while the runtime is active. `startRuntimeActiveGatedInterval`
 * — the same lifecycle owner the shared clocks use — also delivers one catch-up
 * refresh the moment the app returns to the foreground with the cadence overdue,
 * so a returning user never reads a badge that went stale in the background.
 */
export function useScmSessionAutoRefresh(params: Readonly<{
    sessionId: string | null | undefined;
    intervalMs: number;
}>): void {
    const { sessionId, intervalMs } = params;

    React.useEffect(() => {
        if (!sessionId) return undefined;
        scmStatusSync.invalidateFromAutoRefresh(sessionId);
        return startRuntimeActiveGatedInterval(() => {
            scmStatusSync.invalidateFromAutoRefresh(sessionId);
        }, intervalMs);
    }, [intervalMs, sessionId]);
}
