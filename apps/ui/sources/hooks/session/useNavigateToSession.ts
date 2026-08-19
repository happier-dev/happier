import * as React from 'react';
import { useRouter } from 'expo-router';

import { getCurrentAuth } from '@/auth/context/AuthContext';

import { navigateToSessionRoute, type NavigateToSessionOptions } from './navigateToSessionRoute';

export type { NavigateToSessionOptions } from './navigateToSessionRoute';

/**
 * The React entry shape of `navigateToSessionRoute` — the one way a surface opens an existing
 * session. Every in-app entry point (inbox, friends, transcript links, voice, zen, command palette,
 * approvals, notifications) routes through it so the session route stays singular and server-scoped.
 *
 * Auth is read from the module accessor at press time rather than through `useAuth`, for the same
 * reason the imperative entry does: the refresh callback is only needed WHEN a server switch fires,
 * and a hook this widely mounted must not make every host a mandatory `AuthProvider` descendant.
 */
export function useNavigateToSession() {
    const router = useRouter();

    return React.useCallback(async (sessionId: string, opts?: NavigateToSessionOptions) => {
        navigateToSessionRoute({
            router,
            sessionId,
            serverId: opts?.serverId ?? null,
            ...(opts?.query ? { query: opts.query } : null),
            refreshAuth: getCurrentAuth()?.refreshFromActiveServer ?? null,
        });
    }, [router]);
}
