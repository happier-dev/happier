import { decodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { type AuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';

export async function createEncryptionFromAuthCredentials(credentials: AuthCredentials): Promise<Encryption> {
    if (!isLegacyAuthCredentials(credentials)) {
        const publicKey = decodeBase64(credentials.encryption.publicKey, 'base64');
        const machineKey = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (publicKey.length !== 32 || machineKey.length !== 32) {
            throw new Error('Invalid dataKey credential key lengths');
        }
        return await Encryption.createFromContentKeyPair({ publicKey, machineKey });
    }

    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    return await Encryption.create(secretKey);
}
