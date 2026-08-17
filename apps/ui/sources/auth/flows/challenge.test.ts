import { describe, expect, it } from 'vitest';

import sodium from '@/encryption/libsodium.lib';

import {
    authChallenge,
    deriveAccountSigningPublicKey,
    signAccountPayload,
} from './challenge';
import {
    createExpectedAccountKeyChallengeSigningInputV1,
} from '@happier-dev/protocol';

describe('Account signing', () => {
    it('signs caller-provided bytes with the canonical Account key', () => {
        const secret = new Uint8Array(32).fill(7);
        const payload = new TextEncoder().encode(
            'request-bound account migration',
        );

        const signature = signAccountPayload(secret, payload);
        const publicKey = deriveAccountSigningPublicKey(secret);

        expect(signature).toHaveLength(64);
        expect(publicKey).toHaveLength(32);
        expect(
            sodium.crypto_sign_verify_detached(
                signature,
                payload,
                publicKey,
            ),
        ).toBe(true);
    });

    it('binds an expected Account id to the generated key challenge', () => {
        const secret = new Uint8Array(32).fill(8);
        const expectedAccountId = 'account-expected';
        const result = authChallenge(secret, {
            expectedAccountId,
        });

        expect(
            sodium.crypto_sign_verify_detached(
                result.signature,
                createExpectedAccountKeyChallengeSigningInputV1({
                    challenge: result.challenge,
                    expectedAccountId,
                }),
                result.publicKey,
            ),
        ).toBe(true);
        expect(
            sodium.crypto_sign_verify_detached(
                result.signature,
                result.challenge,
                result.publicKey,
            ),
        ).toBe(false);
    });
});
