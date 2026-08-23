import { describe, expect, it } from 'vitest';

import sodium from '@/encryption/libsodium.lib';

import {
    authChallenge,
    authChallengeV2,
    deriveAccountSigningPublicKey,
    signAccountPayload,
} from './challenge';
import {
    createExpectedAccountKeyChallengeSigningInputV1,
    createKeyChallengeV2SigningInput,
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

    it('signs only the selected server audience for a v2 challenge', () => {
        const secret = new Uint8Array(32).fill(9);
        const challenge = {
            challengeId: 'challenge-123',
            nonce: 'nonce-abc',
            issuedAt: '2026-08-22T12:00:00.000Z',
            expiresAt: '2026-08-22T12:05:00.000Z',
            audience: {
                origin: 'https://selected.example.test',
                serverIdentityId: 'srv_selected',
            },
        };

        const result = authChallengeV2(secret, {
            challenge,
            expectedAudience: challenge.audience,
        });

        expect(
            sodium.crypto_sign_verify_detached(
                result.signature,
                createKeyChallengeV2SigningInput(challenge),
                result.publicKey,
            ),
        ).toBe(true);
        expect(() => authChallengeV2(secret, {
            challenge,
            expectedAudience: {
                origin: 'https://attacker.example.test',
                serverIdentityId: 'srv_attacker',
            },
        })).toThrow(/audience/i);
    });
});
