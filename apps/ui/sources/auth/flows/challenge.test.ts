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
} from '@happier-dev/protocol/auth/keyChallenge';
import {
    HOME_ADDRESS_MISMATCH_AUTH_CODE,
    HOME_IDENTITY_MISMATCH_AUTH_CODE,
} from './authenticationFailure';
import { HappyError } from '@/utils/errors/errors';

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

    it('refuses an issued v2 address the caller has not accepted', () => {
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

        let thrown: unknown;
        try {
            authChallengeV2(secret, {
                challenge,
                expectedAudience: {
                    origin: 'http://192.168.1.5:3005',
                    serverIdentityId: 'srv_selected',
                },
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(HappyError);
        expect(thrown).toMatchObject({
            kind: 'auth',
            code: HOME_ADDRESS_MISMATCH_AUTH_CODE,
        });
    });

    it('signs the issued v2 audience when the same Home is reached through another accepted origin', () => {
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
            // Same Home, reached over the LAN instead of its canonical origin.
            expectedAudience: {
                origin: 'http://192.168.1.5:3005',
                serverIdentityId: 'srv_selected',
            },
            acceptAlternateOrigin: true,
        });

        expect(
            sodium.crypto_sign_verify_detached(
                result.signature,
                createKeyChallengeV2SigningInput(challenge),
                result.publicKey,
            ),
        ).toBe(true);
    });

    it('refuses a v2 challenge issued by a different Home identity', () => {
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

        let thrown: unknown;
        try {
            authChallengeV2(secret, {
                challenge,
                expectedAudience: {
                    // Identical origin, different Home: a relayed challenge.
                    origin: 'https://selected.example.test',
                    serverIdentityId: 'srv_other_home',
                },
                acceptAlternateOrigin: true,
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(HappyError);
        expect(thrown).toMatchObject({
            kind: 'auth',
            code: HOME_IDENTITY_MISMATCH_AUTH_CODE,
        });
    });
});
