import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { AuthCredentialLifecycleResult } from '@/auth/context/AuthContext';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';

export async function removeServerProfileUiAction(params: Readonly<{
    profileId: string;
    serverUrl: string;
}>): Promise<AuthCredentialLifecycleResult> {
    const profileId = String(params.profileId ?? '').trim();
    if (!profileId || profileId === 'active') {
        return { kind: 'completed' };
    }

    const serverUrl = String(params.serverUrl ?? '').trim();
    if (serverUrl) {
        const guard =
            await guardAccountEncryptionFirstKeyCredentialMutation({
                serverUrl,
                serverId: profileId,
            });
        if (guard.kind !== 'allowed') {
            return guard;
        }
    }

    if (serverUrl) {
        const removed =
            await TokenStorage.removeCredentialsForServerUrl(
                serverUrl,
                { serverId: profileId },
            );
        if (!removed) {
            throw new Error('Failed to remove server credentials');
        }
    }

    removeServerProfile(profileId);
    return { kind: 'completed' };
}
