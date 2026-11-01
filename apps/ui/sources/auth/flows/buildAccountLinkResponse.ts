import { assertCurrentAccountKeyForProvisioning } from './assertCurrentAccountKeyForProvisioning';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials, isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBox, encryptBox } from '@/encryption/libsodium';

const ACCOUNT_LINK_MAGIC = new Uint8Array([0x48, 0x50, 0x41, 0x43]); // HPAC
const LEGACY_TAG = 0;
const DATA_KEY_TAG = 1;
const TOKEN_ONLY_TAG = 2;

function decodeKey(value: string, encoding: 'base64' | 'base64url'): Uint8Array {
    const bytes = decodeBase64(value, encoding);
    if (bytes.length !== 32) throw new Error('Invalid account link credential key length');
    return bytes;
}

export async function buildAccountLinkResponse(
    credentials: AuthCredentials,
    recipientPublicKey: Uint8Array,
    options: Readonly<{ supportsCredentialVariants?: boolean }> = {},
): Promise<Uint8Array> {
    await assertCurrentAccountKeyForProvisioning(credentials);
    if (options.supportsCredentialVariants !== true) {
        if (!isLegacyAuthCredentials(credentials)) {
            throw new Error('Account link requires a client that supports credential variants');
        }
        return encryptBox(decodeKey(credentials.secret, 'base64url'), recipientPublicKey);
    }

    const material = isLegacyAuthCredentials(credentials)
        ? { tag: LEGACY_TAG, keys: [decodeKey(credentials.secret, 'base64url')] }
        : isDataKeyAuthCredentials(credentials)
            ? { tag: DATA_KEY_TAG, keys: [decodeKey(credentials.encryption.publicKey, 'base64'), decodeKey(credentials.encryption.machineKey, 'base64')] }
            : { tag: TOKEN_ONLY_TAG, keys: [] };
    const plaintext = new Uint8Array(ACCOUNT_LINK_MAGIC.length + 1 + material.keys.length * 32);
    plaintext.set(ACCOUNT_LINK_MAGIC);
    plaintext[ACCOUNT_LINK_MAGIC.length] = material.tag;
    material.keys.forEach((key, index) => plaintext.set(key, ACCOUNT_LINK_MAGIC.length + 1 + index * 32));
    return encryptBox(plaintext, recipientPublicKey);
}

export function openAccountLinkResponse(payload: Uint8Array, recipientSecretKey: Uint8Array, token: string): AuthCredentials | null {
    const plaintext = decryptBox(payload, recipientSecretKey);
    if (!plaintext) return null;
    // Released account links seal exactly the 32-byte legacy recovery secret.
    if (plaintext.length === 32) return { token, secret: encodeBase64(plaintext, 'base64url') };
    if (!ACCOUNT_LINK_MAGIC.every((byte, index) => plaintext[index] === byte)) return null;
    const tag = plaintext[ACCOUNT_LINK_MAGIC.length];
    const keys = plaintext.slice(ACCOUNT_LINK_MAGIC.length + 1);
    if (tag === TOKEN_ONLY_TAG && keys.length === 0) return { token };
    if (tag === LEGACY_TAG && keys.length === 32) return { token, secret: encodeBase64(keys, 'base64url') };
    if (tag === DATA_KEY_TAG && keys.length === 64) {
        return {
            token,
            encryption: {
                publicKey: encodeBase64(keys.slice(0, 32)),
                machineKey: encodeBase64(keys.slice(32)),
            },
        };
    }
    return null;
}
