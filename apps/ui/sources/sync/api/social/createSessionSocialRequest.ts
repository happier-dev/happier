import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { createSessionRequestWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { getFriendsList } from '@/sync/api/social/apiFriends';

export function createSessionSocialRequest(credentials: AuthCredentials, sessionId: string) {
    return createSessionRequestWithServerScope({
        serverId: resolvePreferredServerIdForSessionId(sessionId) ?? null,
        activeRequest: (path, init) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${credentials.token}`);
            return serverFetch(path, {
                ...init,
                headers,
            }, { includeAuth: false });
        },
    });
}

export async function getSessionFriendsList(
    credentials: AuthCredentials,
    sessionId: string,
) {
    return await getFriendsList(credentials, {
        request: createSessionSocialRequest(credentials, sessionId),
    });
}
