import type { Router } from 'expo-router';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';

import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { markSessionOpenRequestedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { buildScopedSessionRouteHref } from './sessionRouteServerScope';

/**
 * Opening an existing session is ONE decision, spelled here.
 *
 * It resolves the owning server (explicit, else the local cache), builds the server-scoped href,
 * marks the open for telemetry, and navigates SINGULARLY so `/session/<id>` never accumulates in the
 * back stack — inbox → session → session is one session entry, and back returns to the list. Callers
 * that pushed a raw `/session/<id>` got none of that: a growing stack, no server scope for hydration
 * to recover from, and an invisible open in the telemetry.
 *
 * Two entry shapes, one owner: `useNavigateToSession` for React surfaces, this function for the
 * imperative callers (notification response routing, voice tools) that have no hook to call from.
 */

export type SessionRouteQuery = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type NavigateToSessionOptions = Readonly<{
    /** The session's owning server. Falls back to the local cache when omitted. */
    serverId?: string | null;
    /** Extra route params carried onto the session href, e.g. `jumpSeq`. */
    query?: SessionRouteQuery;
}>;

/** Only the one method this needs, so an imperative caller can pass the module `router`. */
export type SessionRouteNavigator = Pick<Router, 'navigate'>;

export function navigateToSessionRoute(params: Readonly<{
    router: SessionRouteNavigator;
    sessionId: string;
    refreshAuth?: (() => Promise<void>) | null;
}> & NavigateToSessionOptions): void {
    const targetServerId = String(params.serverId ?? '').trim()
        || resolveServerIdForSessionIdFromLocalCache(params.sessionId);
    const href = buildScopedSessionRouteHref({
        sessionId: params.sessionId,
        serverId: targetServerId || null,
        ...(params.query ? { query: params.query } : null),
    });
    markSessionOpenRequestedForSessionUiTelemetry({
        sessionId: params.sessionId,
        source: 'navigate-hook',
    });
    params.router.navigate(href, {
        dangerouslySingular() {
            return 'session';
        },
    });

    if (targetServerId) {
        // Keep route navigation independent; the explicit server scope lets hydration recover if
        // switching fails.
        //
        // Keep route navigation independent; the explicit server scope lets hydration recover if switching fails.
        fireAndForget(setActiveServerAndSwitch({
            serverId: targetServerId,
            scope: 'device',
            refreshAuth: params.refreshAuth ?? null,
        }));
    }
}
