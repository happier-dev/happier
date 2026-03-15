import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';

function resolveAccountLinkSecretBytes(credentials: AuthCredentials): Uint8Array {
    if (isLegacyAuthCredentials(credentials)) {
        return decodeBase64(credentials.secret, 'base64url');
    }
    return decodeBase64(credentials.encryption.machineKey, 'base64');
}

export function buildAccountLinkResponse(credentials: AuthCredentials, recipientPublicKey: Uint8Array): Uint8Array {
    const secretBytes = resolveAccountLinkSecretBytes(credentials);
    return encryptBox(secretBytes, recipientPublicKey);
}
