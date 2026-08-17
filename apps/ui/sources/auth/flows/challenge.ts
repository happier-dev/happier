import { getRandomBytes } from '@/platform/cryptoRandom';
import sodium from '@/encryption/libsodium.lib';
import {
    createExpectedAccountKeyChallengeSigningInputV1,
} from '@happier-dev/protocol';

export function deriveAccountSigningPublicKey(
    secret: Uint8Array,
): Uint8Array {
    return sodium.crypto_sign_seed_keypair(secret).publicKey;
}

export function signAccountPayload(
    secret: Uint8Array,
    payload: Uint8Array,
): Uint8Array {
    const keypair = sodium.crypto_sign_seed_keypair(secret);
    return sodium.crypto_sign_detached(payload, keypair.privateKey);
}

export function authChallenge(
    secret: Uint8Array,
    options?: Readonly<{
        expectedAccountId: string;
    }>,
) {
    const challenge = getRandomBytes(32);
    const signingInput =
        options
            ? createExpectedAccountKeyChallengeSigningInputV1({
                challenge,
                expectedAccountId:
                    options.expectedAccountId,
            })
            : challenge;
    return {
        challenge,
        signature: signAccountPayload(secret, signingInput),
        publicKey: deriveAccountSigningPublicKey(secret),
    };
}
