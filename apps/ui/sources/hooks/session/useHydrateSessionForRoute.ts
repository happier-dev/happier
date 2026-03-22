import * as React from 'react';

import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Best-effort hydration for deep links / hard refreshes.
 *
 * Some session sub-routes (e.g. fullscreen sidebar/details screens on mobile) can be opened directly
 * without mounting the main `SessionView`, which normally ensures the session exists in storage and
 * initializes its encryption state. Without this, any session-scoped RPC will fail with
 * "Session encryption not found".
 *
 * On failure, this hook retries with exponential backoff to handle transient errors
 * (server switch in flight, temporary RPC failure, stale encryption state, etc.).
 */
export function useHydrateSessionForRoute(sessionId: string, tag: string): boolean {
    const normalizedSessionId = String(sessionId ?? '').trim();
    const [ready, setReady] = React.useState(false);

    React.useEffect(() => {
        let canceled = false;
        let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let attemptCount = 0;

        setReady(false);
        if (!normalizedSessionId) {
            setReady(true);
            return;
        }

        const attemptHydration = () => {
            if (canceled) return;

            attemptCount++;
            const promise = sync.ensureSessionVisibleForMessageRoute(normalizedSessionId);
            fireAndForget(promise, { tag });

            void promise
                .then((hydratedOrTerminal) => {
                    if (canceled) return;
                    if (hydratedOrTerminal) {
                        setReady(true);
                        return;
                    }
                    // Retry with exponential backoff: 2s, 4s, 8s, 16s, max 30s
                    const retryDelayMs = Math.min(2000 * Math.pow(2, attemptCount - 1), 30000);
                    retryTimeoutId = setTimeout(() => {
                        if (!canceled) {
                            attemptHydration();
                        }
                    }, retryDelayMs);
                })
                .catch(() => {
                    if (canceled) return;
                    // Retry with exponential backoff: 2s, 4s, 8s, 16s, max 30s
                    const retryDelayMs = Math.min(2000 * Math.pow(2, attemptCount - 1), 30000);
                    retryTimeoutId = setTimeout(() => {
                        if (!canceled) {
                            attemptHydration();
                        }
                    }, retryDelayMs);
                });
        };

        attemptHydration();

        return () => {
            canceled = true;
            if (retryTimeoutId !== null) {
                clearTimeout(retryTimeoutId);
            }
        };
    }, [normalizedSessionId, tag]);

    return ready;
}
