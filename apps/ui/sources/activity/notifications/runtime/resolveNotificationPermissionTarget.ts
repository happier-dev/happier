import { TokenStorage } from '@/auth/storage/tokenStorage';
import { parseToken } from '@/utils/auth/parseToken';
import { listServerProfiles, resolveServerProfileScopeIdForIdentifier, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

/** The shared saved-Home lookup for notification presentation and execution. */
export function findSavedNotificationServerProfile(serverUrl: string): ServerProfile | null {
    const key = createServerUrlComparableKey(serverUrl);
    if (!key) return null;
    return listServerProfiles().find((candidate) => createServerUrlComparableKey(candidate.serverUrl) === key) ?? null;
}

export async function resolveNotificationPermissionTarget(serverUrl: string, accountId?: string | null,
    options?: Readonly<{ onTargetIdentified?: (scope: ServerAccountScope) => void }>,
): Promise<ServerAccountScope | null> {
    const profile = findSavedNotificationServerProfile(serverUrl);
    if (!profile) return null;
    const serverId = resolveServerProfileScopeIdForIdentifier(profile.id);
    if (!serverId) return null;
    // A known origin remains the recovery destination even when its credentials
    // are unavailable. This metadata cannot authorize a send or navigation.
    const expected = accountId ? createServerAccountScope(serverId, accountId) : null;
    if (expected) options?.onTargetIdentified?.(expected);
    const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
    if (!credentials) return null;
    const scope = createServerAccountScope(serverId, parseToken(credentials.token));
    if (!scope || (accountId && accountId !== scope.accountId)) return null;
    return scope;
}
