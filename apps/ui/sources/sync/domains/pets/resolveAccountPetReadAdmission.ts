import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import type { ServerFetch } from '@/sync/http/client';
import { shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

export type AccountPetReadAdmission =
    | Readonly<{ status: 'ready' }>
    | Readonly<{
        status: 'unavailable';
        reason: 'custom_pet_sync_unavailable';
    }>;

const UNAVAILABLE: AccountPetReadAdmission = Object.freeze({
    status: 'unavailable',
    reason: 'custom_pet_sync_unavailable',
});

export async function resolveAccountPetReadAdmission(
    credentials: AuthCredentials | null | undefined,
    options: Readonly<{ request?: ServerFetch }> = {},
): Promise<AccountPetReadAdmission> {
    if (!credentials) return UNAVAILABLE;

    try {
        const currentness = options.request
            ? await fetchAccountEncryptionCurrentness(credentials, { request: options.request })
            : await fetchAccountEncryptionCurrentness(credentials);
        return currentness.mode === 'plain'
            ? { status: 'ready' }
            : UNAVAILABLE;
    } catch (error) {
        if (shouldRetryError(error)) throw error;
        return UNAVAILABLE;
    }
}
