import type { AccountPetEntryOpenModeV1 } from '@happier-dev/protocol/pets/accountPetEncryptionV1';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionIdentity, type AccountEncryptionReadUsage } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ServerFetch } from '@/sync/http/client';
import { shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

export type AccountPetReadAdmission =
    | Readonly<{ status: 'ready'; account: AccountPetEntryOpenModeV1 }>
    | Readonly<{
        status: 'unavailable';
        reason: 'custom_pet_sync_unavailable';
    }>;

const UNAVAILABLE: AccountPetReadAdmission = Object.freeze({
    status: 'unavailable',
    reason: 'custom_pet_sync_unavailable',
});

/**
 * The Account library's one mode/material decision for UI readers and writers.
 * Plain Accounts read plaintext entries; E2EE Accounts open sealed entries with
 * material proved against the current Account content key. Missing or mismatched
 * material is unavailable, never a Plain fallback.
 */
export async function resolveAccountPetReadAdmission(
    credentials: AuthCredentials | null | undefined,
    options: Readonly<{ request?: ServerFetch; usage?: AccountEncryptionReadUsage }> = {},
): Promise<AccountPetReadAdmission> {
    if (!credentials) return UNAVAILABLE;

    try {
        // Reads borrow the admitted identity; the Home admits each request against persisted mode.
        // Writes pass `fresh-authority` because they seal under the observed mode.
        const currentness = await fetchAccountEncryptionIdentity(credentials, {
            ...(options.request ? { request: options.request } : {}),
            usage: options.usage ?? 'identity',
        });
        if (currentness.mode === 'plain') return { status: 'ready', account: { mode: 'plain' } };
        const snapshot = resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: currentness });
        return snapshot ? { status: 'ready', account: { mode: 'e2ee', material: snapshot.material } } : UNAVAILABLE;
    } catch (error) {
        if (shouldRetryError(error)) throw error;
        return UNAVAILABLE;
    }
}
