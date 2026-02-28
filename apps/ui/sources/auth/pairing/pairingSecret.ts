import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { digest } from '@/platform/digest';

export async function computePairingSecretHash(secret: string): Promise<string> {
    const bytes = new TextEncoder().encode(secret);
    const hashed = await digest('SHA-256', bytes);
    return encodeBase64(hashed, 'base64url');
}

export async function createPairingSecret(): Promise<Readonly<{ secret: string; secretHash: string }>> {
    const secret = encodeBase64(getRandomBytes(32), 'base64url');
    const secretHash = await computePairingSecretHash(secret);
    return { secret, secretHash };
}
