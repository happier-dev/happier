import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@/api/encryption';
import { verifyMachineInstallationProof } from '@happier-dev/protocol';

import { buildInstallationProofForMachine } from './proof';

function createJwt(sub: string): string {
    return [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url'),
        Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url'),
        '',
    ].join('.');
}

describe('installation identity proof', () => {
    it('binds proof to machine id, replacement intent, account id, and content key fingerprint', () => {
        const keyPair = tweetnacl.sign.keyPair();
        const result = buildInstallationProofForMachine({
            identity: {
                version: 1,
                installationId: 'installation-1',
                createdAt: 123,
                publicKey: encodeBase64(keyPair.publicKey, 'base64url'),
                privateKey: encodeBase64(keyPair.secretKey, 'base64url'),
            },
            machineId: 'machine-new',
            token: createJwt('account-1'),
            contentPublicKey: new Uint8Array([1, 2, 3]),
            replacementIntent: {
                replacesMachineId: 'machine-old',
                replacementReason: 'reauth',
            },
        });

        expect(result.installationId).toBe('installation-1');
        expect(result.replacesMachineId).toBe('machine-old');
        expect(result.replacementReason).toBe('reauth');
        expect(result.payload.accountId).toBe('account-1');
        expect(result.contentPublicKeyFingerprint).toMatch(/^content-public-key-sha256:[a-f0-9]{64}$/u);
        expect(verifyMachineInstallationProof({
            payload: result.payload,
            proof: result.installationProof,
            publicKey: result.installationPublicKey,
        })).toBe(true);
        expect(verifyMachineInstallationProof({
            payload: { ...result.payload, replacementReason: 'rotation' },
            proof: result.installationProof,
            publicKey: result.installationPublicKey,
        })).toBe(false);
    });
});
