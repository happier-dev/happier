import tweetnacl from 'tweetnacl';

import sodium from '@/encryption/libsodium.lib';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { TokenStorage, isLegacyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';

/**
 * Parses the account content keypair a keyless sign-in response carries (`content`). Absent means
 * the server did not send one (an older server, or an account that holds its own keys). A present
 * but malformed or mismatched keypair is an error: storing it would leave this device unable to
 * open what other devices seal to the account key.
 */
function parseAccountContentKey(value: unknown): { publicKey: string; machineKey: string } | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object') throw new Error('Invalid account content key');
    const { publicKey, machineKey } = value as Record<string, unknown>;
    if (typeof publicKey !== 'string' || typeof machineKey !== 'string') {
        throw new Error('Invalid account content key');
    }
    const secretKey = decodeBase64(machineKey, 'base64');
    if (secretKey.length !== tweetnacl.box.secretKeyLength) throw new Error('Invalid account content key');
    if (encodeBase64(tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey, 'base64') !== publicKey) {
        throw new Error('Invalid account content key');
    }
    return { publicKey, machineKey };
}

/**
 * Data-key credentials for a token from a keyless sign-in. The account content key the server
 * returned wins, so every device of a keyless account holds the same key; otherwise the device
 * keeps its stored key or creates a random one.
 */
export async function buildDataKeyCredentialsForToken(token: string, accountContentKey?: unknown): Promise<AuthCredentials> {
    const normalizedToken = token.toString();

    const content = parseAccountContentKey(accountContentKey);
    if (content) {
        return { token: normalizedToken, encryption: content };
    }

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
