import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { parseToken } from '@/utils/auth/parseToken';

export async function resolveBugReportAccountIdForServer(serverId: string): Promise<string | null> {
    const profile = getServerProfileById(serverId);
    if (!profile) return null;
    try {
        const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, {
            serverId: resolveServerProfileScopeIdForIdentifier(serverId),
        });
        return credentials ? parseToken(credentials.token) : null;
    } catch {
        // The caller keeps the unknown account explicit, so diagnostics remain
        // unavailable instead of collecting from an account selected later.
        return null;
    }
}
