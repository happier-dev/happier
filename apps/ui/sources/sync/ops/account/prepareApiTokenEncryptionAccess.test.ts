import { describe, expect, it } from 'vitest';
import { computeAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { openApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { prepareApiTokenEncryptionAccess } from './prepareApiTokenEncryptionAccess';

const credentials = { token: 'interactive-token', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
const context = { serverIdentityId: 'srv_token-test', accountId: 'account-a', tokenId: '11111111-1111-4111-8111-111111111111' };

describe('trusted API token encryption preparation', () => {
    it('exports the same narrow content key from recovery-secret and data-key devices', async () => {
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const currentness = {
            mode: 'e2ee' as const, version: 1, updatedAt: 1, signingKeyFingerprint: 'signing',
            contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(encryption.contentDataKey),
            recipientEnvelopeReadiness: { status: 'available' as const },
        };
        for (const device of [credentials, { token: credentials.token, encryption: {
            type: 'dataKey' as const,
            publicKey: encodeBase64(encryption.contentDataKey),
            machineKey: encodeBase64(encryption.getContentPrivateKey()),
        } }]) {
            const prepared = await prepareApiTokenEncryptionAccess({ credentials: device, currentness, ...context });
            expect(openApiTokenEncryptionAccessV1({
                context: { ...context, contentPublicKey: prepared.encryptionAccess.contentPublicKey },
                wrappingSecret: prepared.wrappingSecret,
                encryptionAccess: prepared.encryptionAccess,
            })).toEqual(encryption.getContentPrivateKey());
            expect(prepared.encryptionAccess).not.toHaveProperty('wrappingSecret');
            expect(prepared.encryptionAccess).not.toHaveProperty('secret');
        }
    });

    it('rejects plain, absent and stale binding material without generating replacement keys', async () => {
        const currentness = {
            mode: 'e2ee' as const, version: 1, updatedAt: 1, signingKeyFingerprint: 'signing',
            contentKeyFingerprint: 'wrong-key', recipientEnvelopeReadiness: { status: 'available' as const },
        };
        await expect(prepareApiTokenEncryptionAccess({ credentials, currentness, ...context }))
            .rejects.toThrow('api_token_encryption_stale');
        await expect(prepareApiTokenEncryptionAccess({ credentials, currentness: { ...currentness, mode: 'plain' }, ...context }))
            .rejects.toThrow('api_token_encryption_not_ready');
        await expect(prepareApiTokenEncryptionAccess({ credentials: { token: 'keyless' }, currentness, ...context }))
            .rejects.toThrow('api_token_encryption_not_ready');
    });

    it('fails closed when a released Home answers without recipient envelope readiness', async () => {
        // A Home that predates the readiness projection omits the field entirely. That is
        // "not ready", not a reason to dereference it and crash the whole token flow.
        const { recipientEnvelopeReadiness: _omitted, ...currentness } = {
            mode: 'e2ee' as const, version: 1, updatedAt: 1, signingKeyFingerprint: 'signing',
            contentKeyFingerprint: 'any-key', recipientEnvelopeReadiness: { status: 'available' as const },
        };
        await expect(prepareApiTokenEncryptionAccess({ credentials, currentness, ...context }))
            .rejects.toThrow('api_token_encryption_not_ready');
    });
});
