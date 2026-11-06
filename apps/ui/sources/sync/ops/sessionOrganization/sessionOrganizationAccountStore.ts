import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { isHomeCredentialCurrent } from '@/sync/domains/scope/homeAccountRetirement';

/**
 * Every Organization operation reaches the store through the credentials it was issued with. A write
 * issued for an Account that has since left this Home must not land in the next Account's store,
 * including one whose reply or decryption settles after the retirement cleared it.
 */
export function sessionOrganizationStoreFor(params: Readonly<{ serverId: string; credentials: AuthCredentials }>) {
    if (!isHomeCredentialCurrent(params.serverId, params.credentials)) {
        throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
    return getStorage().getState();
}
