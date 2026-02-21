import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { TokenStorage, isLegacyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';

export async function buildDataKeyCredentialsForToken(token: string): Promise<AuthCredentials> {
    const normalizedToken = token.toString();

    const existing = await TokenStorage.getCredentials();
    if (existing && !isLegacyAuthCredentials(existing)) {
        return { token: normalizedToken, encryption: existing.encryption };
    }

    const seed = await getRandomBytesAsync(32);
    const keyPair = sodium.crypto_box_seed_keypair(seed);
    return {
        token: normalizedToken,
        encryption: {
            publicKey: encodeBase64(keyPair.publicKey),
            machineKey: encodeBase64(keyPair.privateKey),
        },
    };
}

