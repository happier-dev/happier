import * as React from 'react';
import { useRouter } from 'expo-router';

import { resolveSessionTargetServerId } from '@/components/sessions/model/resolveSessionTargetServerId';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { useAuth } from '@/auth/context/AuthContext';

export function useNavigateToSession() {
    const router = useRouter();
    const auth = useAuth();

    return React.useCallback(async (sessionId: string, opts?: Readonly<{ serverId?: string }>) => {
        const explicitServerId = String(opts?.serverId ?? '').trim();
        const targetServerId = explicitServerId || String(resolveSessionTargetServerId(sessionId) ?? '').trim();
        if (targetServerId) {
            void setActiveServerAndSwitch({
                serverId: targetServerId,
                scope: 'device',
                refreshAuth: auth.refreshFromActiveServer,
            }).catch(() => {
                // If switching fails, still try navigation so users can recover in-session.
            });
        }

        router.navigate(`/session/${sessionId}`, {
            dangerouslySingular(name, params) {
                return 'session';
            },
        });
    }, [auth.refreshFromActiveServer, router]);
}
