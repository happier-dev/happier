import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';

export async function removeServerProfileUiAction(params: Readonly<{
    profileId: string;
    serverUrl: string;
}>): Promise<void> {
    const profileId = String(params.profileId ?? '').trim();
    if (!profileId || profileId === 'active') {
        return;
    }

    const serverUrl = String(params.serverUrl ?? '').trim();
    if (serverUrl) {
        try {
            await TokenStorage.removeCredentialsForServerUrl(serverUrl);
        } catch {
            // Best-effort only.
        }
    }

    removeServerProfile(profileId);
}
