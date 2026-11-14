import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { AccountEncryptionCurrentnessReadinessError, fetchAccountEncryptionIdentity, type AccountEncryptionReadUsage } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ServerFetch } from '@/sync/http/client';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { HappyError } from '@/utils/errors/errors';
import { isAccountModeDowngradeUnverifiedError, type AccountEncryptionIdentity } from '@happier-dev/sync-client';

import {
    AccountStorageCurrentnessUnavailableError,
    classifyAccountStorageReadFailure,
} from './accountStorageReadFailure';

export {
    AccountStorageCurrentnessUnavailableError,
    classifyAccountStorageReadFailure,
    type AccountStorageCurrentnessUnavailableReason,
    type AccountStorageReadFailureReason,
} from './accountStorageReadFailure';

export type RawAccountStorageDecryption = Readonly<{
    decryptRaw: (value: string) => Promise<unknown>;
}>;
export type RawAccountStorageEncryption = RawAccountStorageDecryption & Readonly<{
    encryptRaw: (value: unknown) => Promise<string>;
}>;
export type AccountStorageContext = Readonly<{
    mode: 'plain' | 'e2ee';
    encryption: RawAccountStorageDecryption | null;
}>;

export function isRawAccountStorageEncryption(
    value: RawAccountStorageDecryption | null,
): value is RawAccountStorageEncryption {
    return value !== null && 'encryptRaw' in value;
}

/**
 * The one cheap still-active check a read-only catalog or row read makes before disclosing what it
 * read to the same Account. It borrows the connection's already-admitted observation (identity
 * usage): socket delivery withdraws or changes that observation, and an unsettled or withdrawn
 * observation, another credential or a retired Account re-admits over the operation's own HTTP
 * read. A mode change committed but not yet delivered takes effect at the next read (the next
 * natural boundary). Sealing, mutation, cleanup-before-write and cursor witnesses keep
 * `usage: 'fresh-authority'`.
 */
export function resolveAccountStorageContextForDisclosure(
    credentials: AuthCredentials,
    options: Readonly<{ encryption?: AccountStorageContext['encryption']; request?: ServerFetch }>,
): Promise<AccountStorageContext> {
    return resolveAccountStorageContext(credentials, { ...options, usage: 'identity' });
}

/** Capture the cipher before reading identity; effect callers request fresh authority explicitly. */
export async function resolveAccountStorageContext(
    credentials: AuthCredentials,
    options: Readonly<{
        encryption?: AccountStorageContext['encryption'];
        request?: ServerFetch;
        /** Required: identity borrows the admitted observation; fresh-authority is an HTTP authority point. */
        usage: AccountEncryptionReadUsage;
        /** A containing finite read may supply its canonical Account identity. Writes still admit fresh authority. */
        readIdentity?: () => Promise<AccountEncryptionIdentity>;
    }>,
): Promise<AccountStorageContext> {
    const sync = options.encryption === undefined ? getSyncSingleton() : null;
    const encryption = sync ? sync.encryption : options.encryption;
    const mountedCredentials = sync && encryption ? sync.getCredentials() : null;
    try {
        const currentness = await fetchAccountEncryptionIdentity(credentials, {
            ...(options.request ? { request: options.request } : {}),
            ...(options.readIdentity ? { readIdentity: options.readIdentity } : {}),
            usage: options.usage,
        });
        if (currentness.mode === 'plain') return { mode: 'plain', encryption: null };
        if (!encryption || !currentness.contentKeyFingerprint) {
            throw new AccountStorageCurrentnessUnavailableError(
                new Error('Account content-key material is unavailable'), 'encryption-material-unavailable',
            );
        }
        if (sync && (!mountedCredentials
            || resolveAuthCredentialsScopeKey(mountedCredentials) !== resolveAuthCredentialsScopeKey(credentials))) {
            throw new AccountStorageCurrentnessUnavailableError(
                new Error('The mounted Account cipher belongs to another credential scope'), 'scope-retired',
            );
        }
        if (!resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials, accountCurrentness: currentness })) {
            throw new AccountStorageCurrentnessUnavailableError(
                new Error('Account encryption material does not match current Account state'), 'encryption-material-unavailable',
            );
        }
        return { mode: 'e2ee', encryption };
    } catch (error) {
        if (error instanceof AccountStorageCurrentnessUnavailableError) throw error;
        const classified = classifyAccountStorageReadFailure(error);
        const reason = classified === 'unauthorized' || classified === 'forbidden'
            ? classified
            : error instanceof HappyError && error.status === 404 && error.kind === 'config'
                    && error.code === 'account-encryption-currentness-unavailable' ? 'unsupported'
                : error instanceof AccountEncryptionCurrentnessReadinessError
                    || (error instanceof HappyError && error.status === 200 && error.kind === 'server'
                        && error.code === 'account-encryption-currentness-unavailable')
                    || isAccountModeDowngradeUnverifiedError(error)
                    ? 'encryption-material-unavailable'
                    : classified === 'scope-retired' ? 'scope-retired' : 'unreachable';
        throw new AccountStorageCurrentnessUnavailableError(error, reason);
    }
}
