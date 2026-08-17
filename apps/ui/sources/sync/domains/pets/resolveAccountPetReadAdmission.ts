import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';

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
): Promise<AccountPetReadAdmission> {
    if (!credentials) return UNAVAILABLE;

    try {
        const currentness = await fetchAccountEncryptionCurrentness(credentials);
        return currentness.mode === 'plain'
            ? { status: 'ready' }
            : UNAVAILABLE;
    } catch {
        return UNAVAILABLE;
    }
}
