import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isDataKeyAuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';

function resolveAccountLinkSecretBytes(credentials: AuthCredentials): Uint8Array {
    if (isLegacyAuthCredentials(credentials)) {
        return decodeBase64(credentials.secret, 'base64url');
    }
    if (isDataKeyAuthCredentials(credentials)) {
        const payload = JSON.stringify({
            type: 'dataKey',
            publicKey: credentials.encryption.publicKey,
            machineKey: credentials.encryption.machineKey,
        });
        return new TextEncoder().encode(payload);
    }
    return new TextEncoder().encode(JSON.stringify({ type: 'tokenOnly' }));
}

export function buildAccountLinkResponse(credentials: AuthCredentials, recipientPublicKey: Uint8Array): Uint8Array {
    const secretBytes = resolveAccountLinkSecretBytes(credentials);
    return encryptBox(secretBytes, recipientPublicKey);
}
