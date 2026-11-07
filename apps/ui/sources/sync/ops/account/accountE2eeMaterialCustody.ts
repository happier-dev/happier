import type { AuthContextType } from '@/auth/context/AuthContext';
import {
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    readAccountE2eeCustody,
    withAccountE2eeCustody,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import type { CapturedAccountSettingsRequest } from '@/sync/api/account/accountSettingsRequest';

/**
 * This device's one writer for the custody of its Account E2EE material. The
 * key bytes never change; removing them stays the confirmed Forget Action.
 */
export async function persistAccountE2eeMaterialCustody(params: Readonly<{
    credentials: AuthCredentials;
    custody: 'active' | 'historical';
    captured: CapturedAccountSettingsRequest;
    persistCredentials: AuthContextType['loginWithCredentials'];
}>): Promise<boolean> {
    const { credentials, captured } = params;
    if (!isLegacyAuthCredentials(credentials) && !isDataKeyAuthCredentials(credentials)) return false;
    if (readAccountE2eeCustody(credentials) === params.custody) return true;
    const next = withAccountE2eeCustody(credentials, params.custody);
    captured.prepareCredentialAdoption(next);
    const result = await params.persistCredentials(next, {
        target: { serverUrl: captured.target.serverUrl, serverId: captured.target.serverId },
        expectedCredentials: credentials,
    });
    return result.kind === 'completed';
}
