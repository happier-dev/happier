import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { MachineRegistrationIdentitySchema } from './types';

const publicKey = Buffer.from(new Uint8Array(tweetnacl.sign.publicKeyLength)).toString('base64url');
const signature = Buffer.from(new Uint8Array(tweetnacl.sign.signatureLength)).toString('base64url');

const validRegistrationIdentity = {
    installationId: 'installation-1',
    installationPublicKey: publicKey,
    installationProof: {
        version: 1,
        algorithm: 'ed25519',
        signature,
    },
    replacesMachineId: 'machine-old',
    replacementReason: 'reauth',
    contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
};

describe('MachineRegistrationIdentitySchema', () => {
    it('accepts a valid explicit machine replacement identity override', () => {
        expect(MachineRegistrationIdentitySchema.parse(validRegistrationIdentity)).toEqual(validRegistrationIdentity);
    });

    it('rejects malformed replacement reason and content key fingerprint overrides', () => {
        expect(MachineRegistrationIdentitySchema.safeParse({
            ...validRegistrationIdentity,
            replacementReason: 'not valid',
        }).success).toBe(false);

        expect(MachineRegistrationIdentitySchema.safeParse({
            ...validRegistrationIdentity,
            contentPublicKeyFingerprint: 'sha256:' + 'a'.repeat(64),
        }).success).toBe(false);
    });
});
