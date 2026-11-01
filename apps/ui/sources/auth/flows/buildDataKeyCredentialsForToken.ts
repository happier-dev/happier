import { readServerEnabledBit } from '@happier-dev/protocol';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { parseToken } from '@/utils/auth/parseToken';

export async function buildDataKeyCredentialsForToken(token: string): Promise<AuthCredentials> {
    const normalizedToken = token.toString();
    const accountId = parseToken(normalizedToken);

    const existing = await TokenStorage.getCredentials();
    let existingAccountId: string | null = null;
    if (existing) {
        try {
            existingAccountId = parseToken(existing.token);
        } catch {
            // An unreadable stored identity cannot authorize retaining its content keys.
        }
    }
    if (existing && existingAccountId === accountId) {
        return { ...existing, token: normalizedToken };
    }

    const serverFeatures = await getReadyServerFeatures();
    if (!serverFeatures || readServerEnabledBit(serverFeatures, 'encryption.plaintextMachine') !== true) {
        throw new Error('Authentication failed: this server does not support token-only login with plaintext Machine access.');
    }
    return { token: normalizedToken };
}

