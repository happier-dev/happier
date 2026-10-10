import { decodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import {
    type AuthCredentials,
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
} from '@/auth/storage/tokenStorage';

export class AccountEncryptionMaterialUnavailableError extends Error {
    readonly code = 'encryption-material-unavailable';

    constructor(message = 'Account encryption material is unavailable for token-only credentials') {
        super(message);
        this.name = 'AccountEncryptionMaterialUnavailableError';
    }
}

export async function createEncryptionFromAuthCredentials(credentials: AuthCredentials): Promise<Encryption> {
    if (isDataKeyAuthCredentials(credentials)) {
        const publicKey = decodeBase64(credentials.encryption.publicKey, 'base64');
        const machineKey = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (publicKey.length !== 32 || machineKey.length !== 32) {
            throw new AccountEncryptionMaterialUnavailableError('Invalid dataKey credential key lengths');
        }
        return await Encryption.createFromContentKeyPair({ publicKey, machineKey });
    }

    if (!isLegacyAuthCredentials(credentials)) {
        throw new AccountEncryptionMaterialUnavailableError();
    }

    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new AccountEncryptionMaterialUnavailableError(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    return await Encryption.create(secretKey);
}
