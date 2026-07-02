import * as React from 'react';
import { useRouter } from 'expo-router';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { markSessionOpenRequestedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { useAuth } from '@/auth/context/AuthContext';
import { buildScopedSessionRouteHref } from './sessionRouteServerScope';

export function useNavigateToSession() {
    const router = useRouter();
    const auth = useAuth();

    return React.useCallback(async (sessionId: string, opts?: Readonly<{ serverId?: string }>) => {
        const explicitServerId = String(opts?.serverId ?? '').trim();
        const normalizedSessionId = normalizeSessionId(sessionId);
        const targetServerId = explicitServerId || String(resolvePreferredServerIdForSessionId(normalizedSessionId) ?? '').trim();
        markSessionOpenRequestedForSessionUiTelemetry({
            sessionId: normalizedSessionId,
            source: 'navigate-hook',
        });
        if (targetServerId) {
            void setActiveServerAndSwitch({
                serverId: targetServerId,
                scope: 'device',
                refreshAuth: auth.refreshFromActiveServer,
            }).catch(() => {
                // If switching fails, still try navigation so users can recover in-session.
            });
        }

        router.navigate(buildScopedSessionRouteHref({
            sessionId: normalizedSessionId,
            serverId: targetServerId || null,
        }), {
            dangerouslySingular(name, params) {
                return 'session';
            },
        });
    }, [auth.refreshFromActiveServer, router]);
}
