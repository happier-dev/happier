import { scryptAsync } from '@noble/hashes/scrypt';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptSecretBox, encryptSecretBox } from '@/encryption/libsodium';
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';

/**
 * Key handling for the device app lock.
 *
 * A random 32-byte data key seals this device's stored credentials. The data key itself is stored
 * only in wrapped form: once under a key derived from the password (scrypt) and once under a random
 * recovery key that is escrowed with the relay server for email-based password resets. Changing the
 * password re-wraps the same data key, so sealed credentials never need re-encrypting.
 */

/** scrypt cost for new passwords: about 32 MiB of memory, which keeps unlock tolerable on phones. */
export const APP_LOCK_SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });

export type AppLockKdfParams = Readonly<{ N: number; r: number; p: number }>;

export type AppLockWrappedKeys = Readonly<{
    kdf: Readonly<{ alg: 'scrypt'; N: number; r: number; p: number; salt: string }>;
    passwordWrappedKey: string;
    recoveryWrappedKey: string;
}>;

const DATA_KEY_BYTES = 32;
const SALT_BYTES = 16;
const SEALED_CREDENTIAL_PREFIX = 'happier-app-lock:v1:';

async function derivePasswordKey(password: string, kdf: AppLockWrappedKeys['kdf']): Promise<Uint8Array> {
    return await scryptAsync(new TextEncoder().encode(password.normalize('NFKC')), decodeBase64(kdf.salt), {
        N: kdf.N,
        r: kdf.r,
        p: kdf.p,
        dkLen: DATA_KEY_BYTES,
    });
}

function wrapKey(dataKey: Uint8Array, wrappingKey: Uint8Array): string {
    return encodeBase64(encryptSecretBox(encodeBase64(dataKey), wrappingKey));
}

function unwrapKey(wrapped: string, wrappingKey: Uint8Array): Uint8Array | null {
    let opened: unknown;
    try {
        opened = decryptSecretBox(decodeBase64(wrapped), wrappingKey);
    } catch {
        return null;
    }
    if (typeof opened !== 'string') return null;
    const dataKey = decodeBase64(opened);
    return dataKey.length === DATA_KEY_BYTES ? dataKey : null;
}

async function wrapWithPassword(
    dataKey: Uint8Array,
    password: string,
    params: AppLockKdfParams,
): Promise<Pick<AppLockWrappedKeys, 'kdf' | 'passwordWrappedKey'>> {
    const kdf = { alg: 'scrypt' as const, N: params.N, r: params.r, p: params.p, salt: encodeBase64(getRandomBytes(SALT_BYTES)) };
    return { kdf, passwordWrappedKey: wrapKey(dataKey, await derivePasswordKey(password, kdf)) };
}

export async function createAppLockKeys(
    password: string,
    params: AppLockKdfParams = APP_LOCK_SCRYPT_PARAMS,
): Promise<Readonly<{ dataKey: Uint8Array; recoveryKey: string; wrapped: AppLockWrappedKeys }>> {
    await sodium.ready;
    const dataKey = getRandomBytes(DATA_KEY_BYTES);
    const recoveryKeyBytes = getRandomBytes(DATA_KEY_BYTES);
    const passwordPart = await wrapWithPassword(dataKey, password, params);
    return {
        dataKey,
        recoveryKey: encodeBase64(recoveryKeyBytes),
        wrapped: { ...passwordPart, recoveryWrappedKey: wrapKey(dataKey, recoveryKeyBytes) },
    };
}

export async function unwrapAppLockKeyWithPassword(wrapped: AppLockWrappedKeys, password: string): Promise<Uint8Array | null> {
    await sodium.ready;
    return unwrapKey(wrapped.passwordWrappedKey, await derivePasswordKey(password, wrapped.kdf));
}

export async function unwrapAppLockKeyWithRecoveryKey(wrapped: AppLockWrappedKeys, recoveryKey: string): Promise<Uint8Array | null> {
    await sodium.ready;
    const recoveryKeyBytes = decodeBase64(recoveryKey);
    if (recoveryKeyBytes.length !== DATA_KEY_BYTES) return null;
    return unwrapKey(wrapped.recoveryWrappedKey, recoveryKeyBytes);
}

/** Wraps the existing data key under a new password; the recovery wrapping is kept. */
export async function rewrapAppLockPassword(
    wrapped: AppLockWrappedKeys,
    dataKey: Uint8Array,
    newPassword: string,
    params: AppLockKdfParams = APP_LOCK_SCRYPT_PARAMS,
): Promise<AppLockWrappedKeys> {
    await sodium.ready;
    return { ...wrapped, ...(await wrapWithPassword(dataKey, newPassword, params)) };
}

/** Wraps the existing data key under a new recovery key; the password wrapping is kept. */
export async function rewrapAppLockRecoveryKey(
    wrapped: AppLockWrappedKeys,
    dataKey: Uint8Array,
    recoveryKey: string,
): Promise<AppLockWrappedKeys> {
    await sodium.ready;
    return { ...wrapped, recoveryWrappedKey: wrapKey(dataKey, decodeBase64(recoveryKey)) };
}

export function generateAppLockRecoveryKey(): string {
    return encodeBase64(getRandomBytes(DATA_KEY_BYTES));
}

export function isSealedAppLockCredential(stored: string): boolean {
    return stored.startsWith(SEALED_CREDENTIAL_PREFIX);
}

/**
 * Seals a stored credential value. The result is deliberately not JSON, so an app build without
 * app lock reads it as "no credentials" instead of signing in.
 */
export async function sealAppLockCredential(dataKey: Uint8Array, plaintext: string): Promise<string> {
    await sodium.ready;
    return `${SEALED_CREDENTIAL_PREFIX}${encodeBase64(encryptSecretBox(plaintext, dataKey))}`;
}

export async function openAppLockCredential(dataKey: Uint8Array, stored: string): Promise<string | null> {
    if (!isSealedAppLockCredential(stored)) return null;
    await sodium.ready;
    try {
        const opened = decryptSecretBox(decodeBase64(stored.slice(SEALED_CREDENTIAL_PREFIX.length)), dataKey);
        return typeof opened === 'string' ? opened : null;
    } catch {
        return null;
    }
}
