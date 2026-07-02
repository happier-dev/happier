import * as React from 'react';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveServerProfileScopeId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type ServerAuthStatus = 'signedIn' | 'signedOut' | 'unknown';

type ServerProfileLike = Pick<ServerProfile, 'id' | 'serverUrl' | 'serverIdentityId'>;

export function useServerAuthStatusByServerId(servers: ReadonlyArray<ServerProfileLike>): Readonly<Record<string, ServerAuthStatus>> {
    const [statusById, setStatusById] = React.useState<Record<string, ServerAuthStatus>>({});

    React.useEffect(() => {
        let cancelled = false;
        fireAndForget((async () => {
            const entries = await Promise.all(servers.map(async (profile) => {
                const scopeId = resolveServerProfileScopeId(profile);
                try {
                    const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                    return [scopeId, creds ? 'signedIn' : 'signedOut'] as const;
                } catch {
                    return [scopeId, 'unknown'] as const;
                }
            }));
            if (cancelled) return;
            const next: Record<string, ServerAuthStatus> = {};
            for (const [id, status] of entries) next[id] = status;
            setStatusById(next);
        })(), { tag: 'useServerAuthStatusByServerId.load' });
        return () => {
            cancelled = true;
        };
    }, [servers]);

    return statusById;
}
