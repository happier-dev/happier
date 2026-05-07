import * as React from 'react';
import { useRouter } from 'expo-router';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { useAuth } from '@/auth/context/AuthContext';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { buildScopedSessionRouteHref } from './sessionRouteServerScope';

export function useNavigateToSession() {
    const router = useRouter();
    const auth = useAuth();

    return React.useCallback(async (sessionId: string, opts?: Readonly<{ serverId?: string }>) => {
        const targetServerId = String(opts?.serverId ?? '').trim() || resolveServerIdForSessionIdFromLocalCache(sessionId);
        const href = buildScopedSessionRouteHref({
            sessionId,
            serverId: targetServerId || null,
        });
        router.navigate(href, {
            dangerouslySingular(name, params) {
                return 'session';
            },
        });

        if (targetServerId) {
            // Keep route navigation independent; the explicit server scope lets hydration recover if switching fails.
            fireAndForget(setActiveServerAndSwitch({
                serverId: targetServerId,
                scope: 'device',
                refreshAuth: auth.refreshFromActiveServer,
            }));
        }
    }, [auth.refreshFromActiveServer, router]);
}
