import * as React from 'react';

import { TokenStorage } from '@/auth/storage/tokenStorage';

export type ServerAuthStatus = 'signedIn' | 'signedOut' | 'unknown';

type ServerProfileLike = Readonly<{ id: string; serverUrl: string }>;

export function useServerAuthStatusByServerId(servers: ReadonlyArray<ServerProfileLike>): Readonly<Record<string, ServerAuthStatus>> {
    const [statusById, setStatusById] = React.useState<Record<string, ServerAuthStatus>>({});

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            const entries = await Promise.all(servers.map(async (profile) => {
                try {
                    const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
                    return [profile.id, creds ? 'signedIn' : 'signedOut'] as const;
                } catch {
                    return [profile.id, 'unknown'] as const;
                }
            }));
            if (cancelled) return;
            const next: Record<string, ServerAuthStatus> = {};
            for (const [id, status] of entries) next[id] = status;
            setStatusById(next);
        })();
        return () => {
            cancelled = true;
        };
    }, [servers]);

    return statusById;
}

