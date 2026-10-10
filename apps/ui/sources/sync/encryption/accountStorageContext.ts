import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { decodeBase64 } from '@/encryption/base64';
import { AccountEncryptionCurrentnessReadinessError, fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ServerFetch } from '@/sync/http/client';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { HappyError } from '@/utils/errors/errors';

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

export type AccountStorageCurrentnessUnavailableReason =
    | 'encryption-material-unavailable'
    | 'scope-retired'
    | 'unauthorized'
    | 'forbidden'
    | 'unsupported'
    | 'unreachable';

export class AccountStorageCurrentnessUnavailableError extends Error {
    constructor(
        readonly cause?: unknown,
        readonly reason: AccountStorageCurrentnessUnavailableReason = 'unreachable',
        readonly code: 'account_storage_currentness_unavailable' | 'action_home_signed_out' = 'account_storage_currentness_unavailable',
    ) {
        super(code === 'action_home_signed_out' ? code : 'Account storage currentness is unavailable');
        this.name = 'AccountStorageCurrentnessUnavailableError';
    }
}

export type AccountStorageReadFailureReason = AccountStorageCurrentnessUnavailableReason
    | 'cancelled'
    | 'account-mode-mismatch'
    | 'invalid-stored-content';

function authorizationDenialReason(error: unknown): 'unauthorized' | 'forbidden' | null {
    if (!(error instanceof HappyError)) return null;
    return error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden' : null;
}

/** Private catalog readers share the Account admission boundary, not an offline fallback. */
export function classifyAccountStorageReadFailure(error: unknown, signal?: AbortSignal): AccountStorageReadFailureReason {
    if (signal?.aborted) return 'cancelled';
    if (error instanceof AccountStorageCurrentnessUnavailableError) return error.reason;
    const denial = authorizationDenialReason(error);
    if (denial) return denial;
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code
        : error instanceof Error ? error.message : undefined;
    switch (code) {
        case 'action_account_scope_changed': case 'action_home_not_found': case 'scope-retired':
            return 'scope-retired';
        case 'action_home_signed_out': case 'unauthorized': return 'unauthorized';
        case 'forbidden': case 'unsupported': case 'account-mode-mismatch': case 'encryption-material-unavailable':
        case 'invalid-stored-content': return code;
        case 'account_storage_currentness_unavailable': case 'account_encryption_currentness_unavailable':
        case 'account-encryption-recovery-required': case 'account_settings_encryption_material_unavailable':
            return 'encryption-material-unavailable';
        case 'account_settings_content_invalid': case 'account_settings_content_unreadable':
            return 'invalid-stored-content';
        default: return error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable';
    }
}

export function isRawAccountStorageEncryption(
    value: RawAccountStorageDecryption | null,
): value is RawAccountStorageEncryption {
    return value !== null && 'encryptRaw' in value;
}

/** Capture the cipher before awaiting the authoritative Account-mode/fingerprint read. */
export async function resolveAccountStorageContext(
    credentials: AuthCredentials,
    options: Readonly<{
        encryption?: AccountStorageContext['encryption'];
        request?: ServerFetch;
    }> = {},
): Promise<AccountStorageContext> {
    const sync = options.encryption === undefined ? getSyncSingleton() : null;
    const encryption = sync ? sync.encryption : options.encryption;
    const mountedCredentials = sync && encryption ? sync.getCredentials() : null;
    try {
        const currentness = await fetchAccountEncryptionCurrentness(credentials, {
            ...(options.request ? {
                request: (path, init) => options.request!(path, init, { includeAuth: false, retry: 'none' }),
            } : {}),
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
        try {
            const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
            const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
                accountEncryptionMode: 'e2ee',
                material,
                ...(isDataKeyAuthCredentials(credentials) ? {
                    dataKeyPublicKey: decodeBase64(credentials.encryption.publicKey, 'base64'),
                } : {}),
            });
            if (convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                snapshot.contentPublicKeyFingerprint,
            ) !== currentness.contentKeyFingerprint) {
                throw new Error('Account content-key fingerprint mismatch');
            }
        } catch (error) {
            throw new AccountStorageCurrentnessUnavailableError(error, 'encryption-material-unavailable');
        }
        return { mode: 'e2ee', encryption };
    } catch (error) {
        if (error instanceof AccountStorageCurrentnessUnavailableError) throw error;
        const reason = authorizationDenialReason(error)
            ?? (error instanceof HappyError && error.status === 404 && error.kind === 'config'
                    && error.code === 'account-encryption-currentness-unavailable' ? 'unsupported'
                : error instanceof AccountEncryptionCurrentnessReadinessError
                    || (error instanceof HappyError && error.status === 200 && error.kind === 'server'
                        && error.code === 'account-encryption-currentness-unavailable')
                    ? 'encryption-material-unavailable' : 'unreachable');
        throw new AccountStorageCurrentnessUnavailableError(error, reason);
    }
}
