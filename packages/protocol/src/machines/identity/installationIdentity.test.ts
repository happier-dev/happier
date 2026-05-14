import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../../crypto/base64.js';
import {
    MachineInstallationIdentityV1Schema,
    MachineInstallationProofPayloadV1Schema,
    MachineInstallationProofV1Schema,
    buildMachineInstallationProofPayloadBytes,
    computeContentPublicKeyFingerprint,
    signMachineInstallationProof,
    verifyMachineInstallationProof,
} from './installationIdentity.js';

describe('machine installation identity protocol', () => {
    it('validates persisted installation key material lengths at parse time', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const valid = {
            version: 1,
            installationId: 'installation-1',
            createdAt: 1,
            publicKey: encodeBase64(keyPair.publicKey, 'base64url'),
            privateKey: encodeBase64(keyPair.secretKey, 'base64url'),
        };

        expect(MachineInstallationIdentityV1Schema.safeParse(valid).success).toBe(true);
        expect(MachineInstallationIdentityV1Schema.safeParse({
            ...valid,
            publicKey: encodeBase64(new Uint8Array(tweetnacl.sign.publicKeyLength - 1), 'base64url'),
        }).success).toBe(false);
        expect(MachineInstallationIdentityV1Schema.safeParse({
            ...valid,
            privateKey: encodeBase64(new Uint8Array(tweetnacl.sign.secretKeyLength - 1), 'base64url'),
        }).success).toBe(false);
    });

    it('builds deterministic proof payload bytes independent of input key order', () => {
        const left = buildMachineInstallationProofPayloadBytes({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            accountId: 'account-1',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
        });
        const right = buildMachineInstallationProofPayloadBytes({
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            accountId: 'account-1',
            installationId: 'installation-1',
            version: 1,
        });

        expect(new TextDecoder().decode(left)).toBe(new TextDecoder().decode(right));
        expect(new TextDecoder().decode(left)).toBe(JSON.stringify({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            accountId: 'account-1',
        }));
    });

    it('verifies proof signatures and rejects changed bound fields', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const payload = MachineInstallationProofPayloadV1Schema.parse({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
            accountId: 'account-1',
        });
        const proof = MachineInstallationProofV1Schema.parse(signMachineInstallationProof({
            payload,
            privateKey: keyPair.secretKey,
        }));
        const publicKey = encodeBase64(keyPair.publicKey, 'base64url');

        expect(verifyMachineInstallationProof({ payload, proof, publicKey })).toBe(true);
        expect(verifyMachineInstallationProof({ payload: { ...payload, machineId: 'machine-2' }, proof, publicKey })).toBe(false);
        expect(verifyMachineInstallationProof({ payload: { ...payload, replacesMachineId: 'machine-other' }, proof, publicKey })).toBe(false);
        expect(verifyMachineInstallationProof({ payload: { ...payload, replacementReason: 'rotation' }, proof, publicKey })).toBe(false);
    });

    it('validates proof signatures as unpadded base64url encoded Ed25519 signatures', () => {
        const validSignature = encodeBase64(new Uint8Array(tweetnacl.sign.signatureLength), 'base64url');

        expect(MachineInstallationProofV1Schema.safeParse({
            version: 1,
            algorithm: 'ed25519',
            signature: validSignature,
        }).success).toBe(true);
        expect(MachineInstallationProofV1Schema.safeParse({
            version: 1,
            algorithm: 'ed25519',
            signature: `+${validSignature.slice(1)}`,
        }).success).toBe(false);
        expect(MachineInstallationProofV1Schema.safeParse({
            version: 1,
            algorithm: 'ed25519',
            signature: encodeBase64(new Uint8Array(tweetnacl.sign.signatureLength - 1), 'base64url'),
        }).success).toBe(false);
    });

    it('strictly validates string keys passed to proof helpers before decoding them', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const payload = MachineInstallationProofPayloadV1Schema.parse({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            replacesMachineId: 'machine-old',
            replacementReason: 'reauth',
            accountId: 'account-1',
        });
        const privateKey = encodeBase64(keyPair.secretKey, 'base64url');
        const publicKey = encodeBase64(keyPair.publicKey, 'base64url');
        const proof = signMachineInstallationProof({ payload, privateKey });

        expect(verifyMachineInstallationProof({ payload, proof, publicKey })).toBe(true);
        expect(() => signMachineInstallationProof({ payload, privateKey: `+${privateKey.slice(1)}` })).toThrow(/base64url/i);
        expect(verifyMachineInstallationProof({ payload, proof, publicKey: `/${publicKey.slice(1)}` })).toBe(false);
    });

    it('returns false instead of throwing for invalid verification payloads', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const payload = MachineInstallationProofPayloadV1Schema.parse({
            version: 1,
            installationId: 'installation-1',
            machineId: 'machine-1',
            accountId: 'account-1',
        });
        const proof = signMachineInstallationProof({ payload, privateKey: keyPair.secretKey });
        const publicKey = encodeBase64(keyPair.publicKey, 'base64url');

        expect(verifyMachineInstallationProof({
            payload: {
                ...payload,
                contentPublicKeyFingerprint: 'content-public-key-sha256:not-valid',
            },
            proof,
            publicKey,
        })).toBe(false);
    });

    it('computes a stable account keyspace fingerprint without treating it as installation identity', () => {
        const fingerprint = computeContentPublicKeyFingerprint(new Uint8Array([1, 2, 3, 4]));

        expect(fingerprint).toMatch(/^content-public-key-sha256:[a-f0-9]{64}$/u);
        expect(computeContentPublicKeyFingerprint(new Uint8Array([1, 2, 3, 4]))).toBe(fingerprint);
        expect(computeContentPublicKeyFingerprint(new Uint8Array([4, 3, 2, 1]))).not.toBe(fingerprint);
    });
});
