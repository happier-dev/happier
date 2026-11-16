import * as React from 'react';
import { Platform } from 'react-native';
import { router as rootRouter } from 'expo-router';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { markSessionOpenRequestedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { useAuth } from '@/auth/context/AuthContext';
import { buildScopedSessionRouteHref } from './sessionRouteServerScope';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type NavigateToSessionOptions = Readonly<{
    serverId?: string;
    /** Exact committed server message, resolved by the existing message-detail route. */
    messageId?: string;
    /** Preserve an admitted notification's Session subroute. */
    suffix?: string;
    query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
    /** Voice must establish the Home before changing its primary Session target. */
    requireActiveHome?: boolean;
}>;

/** The hook and interaction-only callers share the same Home switch and destination owner. */
export async function navigateToSession(sessionId: string, opts: NavigateToSessionOptions | undefined, owner: Readonly<{
    router: Pick<ReturnType<typeof useDestinationRouter>, 'navigate'>;
    refreshFromActiveServer: () => Promise<void>;
    /** Account admission already established this active Home before handing off. */
    activeHomeScope?: ServerAccountScope;
}>): Promise<boolean> {
    /**
     * `query` is the same scoped-href query the route already understands
     * (`jumpSeq`, and the session pane's `details`/`path`/`sha`/`right` state).
     * It travels through THIS owner rather than a caller-built href so a deep
     * result — a transcript match, a workspace file, a commit — still gets the
     * Home switch, the telemetry mark and the singular-session navigation that
     * every other session open gets.
     */
    const explicitServerId = String(opts?.serverId ?? '').trim();
    const normalizedSessionId = normalizeSessionId(sessionId);
    const targetServerId = owner.activeHomeScope?.serverId || explicitServerId || String(resolvePreferredServerIdForSessionId(normalizedSessionId) ?? '').trim();
    markSessionOpenRequestedForSessionUiTelemetry({
        sessionId: normalizedSessionId,
        source: 'navigate-hook',
    });
    // A bare Session id only justifies a Home *switch* when the canonical local-state
    // resolver proves exactly one Home; switching on 0 or >1 candidates would let
    // active-Home focus silently choose a different Session. The unqualified route is
    // the existing owner of that unresolved case — it presents the Which Home? chooser
    // for several candidates and asks which saved Home to open it on for none (never
    // the focused Home, Lane 07.1) — so the tap still leads somewhere instead of dying
    // silently.
    let crossedHome = false;
    if (targetServerId && !owner.activeHomeScope) {
        const sourceServerId = getActiveServerSnapshot().serverId;
        try {
            const switched = await setActiveServerAndSwitch({
                serverId: targetServerId,
                scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                refreshAuth: owner.refreshFromActiveServer,
            });
            if (switched === 'blocked' && opts?.requireActiveHome) return false;
            crossedHome = switched === 'switched' && !areServerProfileIdentifiersEquivalent(sourceServerId, targetServerId);
        } catch {
            if (opts?.requireActiveHome) return false;
            // If switching fails, still try navigation so users can recover in-session.
        }
    }

    // A Home switch retires the source Account's workspace/tab callbacks. Enter
    // the target through Expo so its new workspace adopts the qualified route;
    // same-Home opens retain the caller's tab and its local history.
    const router = crossedHome ? rootRouter : owner.router;
    await router.navigate(buildScopedSessionRouteHref({
        sessionId: normalizedSessionId,
        serverId: targetServerId || null,
        ...(opts?.messageId ? { messageId: opts.messageId } : {}),
        ...(opts?.suffix ? { suffix: opts.suffix } : {}),
        ...(opts?.query ? { query: opts.query } : {}),
    }), {
        dangerouslySingular(name, params) {
            return 'session';
        },
    });
    return true;
}

export function useNavigateToSession() {
    const router = useDestinationRouter();
    const auth = useAuth();
    return React.useCallback(async (sessionId: string, opts?: NavigateToSessionOptions): Promise<void> => {
        await navigateToSession(sessionId, opts, { router, refreshFromActiveServer: auth.refreshFromActiveServer });
    }, [auth.refreshFromActiveServer, router]);
}
