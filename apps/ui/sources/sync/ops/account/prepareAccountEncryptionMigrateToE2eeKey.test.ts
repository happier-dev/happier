import { describe, expect, it } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import {
    computeAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';

import {
    prepareAccountEncryptionMigrateToE2eeKey,
} from './prepareAccountEncryptionMigrateToE2eeKey';

function legacyCredentials(fill: number): Extract<
    AuthCredentials,
    { secret: string }
> {
    return {
        token: 'token',
        secret: Buffer.from(new Uint8Array(32).fill(fill))
            .toString('base64url'),
    };
}

describe('prepareAccountEncryptionMigrateToE2eeKey', () => {
    it('reuses a restored Account key when retained fingerprints match', async () => {
        const credentials = legacyCredentials(4);
        const seed = new Uint8Array(32).fill(4);
        const publicKey = (await import('@/auth/flows/challenge'))
            .deriveAccountSigningPublicKey(seed);
        const contentBinding = await (await import(
            '@/auth/oauth/contentKeyBinding'
        )).buildContentKeyBinding(seed);
        const contentPublicKey = decodeBase64(
            contentBinding.contentPublicKey,
        );

        const prepared = await prepareAccountEncryptionMigrateToE2eeKey({
            credentials,
            expectedSigningKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(publicKey),
            expectedContentKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    contentPublicKey,
                ),
        });

        expect(prepared.credentials).toBe(credentials);
    });

    it('requires restore for token-only credentials when a signing key is retained', async () => {
        await expect(prepareAccountEncryptionMigrateToE2eeKey({
            credentials: { token: 'token' },
            expectedSigningKeyFingerprint: 'aemk1_retained-signing',
            expectedContentKeyFingerprint: null,
        })).rejects.toMatchObject({
            code: 'restore_required',
            status: 400,
        });
    });

    it('requires restore when the available secret does not match retained keys', async () => {
        await expect(prepareAccountEncryptionMigrateToE2eeKey({
            credentials: legacyCredentials(5),
            expectedSigningKeyFingerprint: 'aemk1_different-signing',
            expectedContentKeyFingerprint: null,
        })).rejects.toMatchObject({
            code: 'restore_required',
            status: 400,
        });
    });

    it('creates an ephemeral first Account key without mutating token-only credentials', async () => {
        const credentials = { token: 'token' } as const;
        const prepared =
            await prepareAccountEncryptionMigrateToE2eeKey({
                credentials,
                expectedSigningKeyFingerprint: null,
                expectedContentKeyFingerprint: null,
            });

        expect(prepared.requiresExternalAuthProof).toBe(true);
        expect(prepared.credentials).toEqual({
            token: 'token',
            secret: expect.any(String),
        });
        expect(prepared.credentials).not.toBe(credentials);
        expect(prepared.seed).toHaveLength(32);
        expect(credentials).toEqual({ token: 'token' });
        expect(decodeBase64(prepared.keyProof.publicKey)).toHaveLength(32);
        expect(decodeBase64(prepared.keyProof.contentPublicKey)).toHaveLength(32);
    });

    it('rejects a half-keyless Account instead of creating a replacement key', async () => {
        await expect(prepareAccountEncryptionMigrateToE2eeKey({
            credentials: { token: 'token' },
            expectedSigningKeyFingerprint: null,
            expectedContentKeyFingerprint: 'aemk1_retained-content',
        })).rejects.toMatchObject({
            code: 'restore_required',
            status: 400,
        });
    });
});
