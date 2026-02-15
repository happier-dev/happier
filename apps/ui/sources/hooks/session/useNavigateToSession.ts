import * as React from 'react';
import { useRouter } from 'expo-router';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { useAuth } from '@/auth/context/AuthContext';

export function useNavigateToSession() {
    const router = useRouter();
    const auth = useAuth();

    return React.useCallback(async (sessionId: string, opts?: Readonly<{ serverId?: string }>) => {
        const targetServerId = String(opts?.serverId ?? '').trim();
        if (targetServerId) {
            try {
                await setActiveServerAndSwitch({ serverId: targetServerId, scope: 'device', refreshAuth: auth.refreshFromActiveServer });
            } catch {
                // If switching fails, still try navigation so users can recover in-session.
            }
        }

        router.navigate(`/session/${sessionId}`, {
            dangerouslySingular(name, params) {
                return 'session';
            },
        });
    }, [auth.refreshFromActiveServer, router]);
}
