import * as React from 'react';
import { useRouter } from 'expo-router';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { useAuth } from '@/auth/context/AuthContext';

export function useNavigateToSession() {
    const router = useRouter();
    const auth = useAuth();

    return React.useCallback(async (sessionId: string, opts?: Readonly<{ serverId?: string }>) => {
        const explicitServerId = String(opts?.serverId ?? '').trim();
        const normalizedSessionId = normalizeSessionId(sessionId);
        const targetServerId = explicitServerId || String(resolvePreferredServerIdForSessionId(normalizedSessionId) ?? '').trim();
        if (targetServerId) {
            void setActiveServerAndSwitch({
                serverId: targetServerId,
                scope: 'device',
                refreshAuth: auth.refreshFromActiveServer,
            }).catch(() => {
                // If switching fails, still try navigation so users can recover in-session.
            });
        }

        router.navigate(`/session/${normalizedSessionId}`, {
            dangerouslySingular(name, params) {
                return 'session';
            },
        });
    }, [auth.refreshFromActiveServer, router]);
}
