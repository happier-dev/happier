import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';

import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { AES256Encryption } from '@/sync/encryption/encryptor';

import { createEncryptionFromAuthCredentials } from './createEncryptionFromAuthCredentials';

describe('createEncryptionFromAuthCredentials', () => {
    it.each([
        { token: 'legacy-material-token', secret: encodeBase64(new Uint8Array(31), 'base64url') },
        { token: 'data-key-material-token', encryption: {
            publicKey: encodeBase64(new Uint8Array(31)), machineKey: encodeBase64(new Uint8Array(32)),
        } },
    ] as const)('classifies malformed Account material as typed unavailable', async credentials => {
        await expect(createEncryptionFromAuthCredentials(credentials)).rejects.toMatchObject({
            code: 'encryption-material-unavailable',
        });
    });

    it('rejects token-only credentials instead of inventing Account encryption material', async () => {
        await expect(createEncryptionFromAuthCredentials({
            token: 'plain-account-token',
        })).rejects.toThrow('Account encryption material is unavailable for token-only credentials');
    });

    it('creates Encryption from dataKey credentials (publicKey + machineKey) that can decrypt encryption keys', async () => {
        const seed = new Uint8Array(32).fill(7);
        const keyPair = sodium.crypto_box_seed_keypair(seed);

        const credentials = {
            token: 'token-test',
            encryption: {
                publicKey: encodeBase64(keyPair.publicKey),
                machineKey: encodeBase64(keyPair.privateKey),
            },
        } as const;

        const encryption = await createEncryptionFromAuthCredentials(credentials);

        const dataKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const encrypted = await encryption.encryptEncryptionKey(dataKey);
        const decrypted = await encryption.decryptEncryptionKey(encodeBase64(encrypted, 'base64'));

        expect(decrypted).not.toBeNull();
        expect(Array.from(decrypted!)).toEqual(Array.from(dataKey));
    });

    it('decrypts encryption keys for CLI-style dataKey credentials', async () => {
        // CLI derives box public key from a hashed seed, then stores the original seed as machineKey.
        const machineSeed = new Uint8Array(32).fill(11);
        const hashedSeed = new Uint8Array(createHash('sha512').update(machineSeed).digest()).slice(0, 32);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(hashedSeed).publicKey;

        const credentials = {
            token: 'token-test',
            encryption: {
                publicKey: encodeBase64(publicKey),
                machineKey: encodeBase64(machineSeed),
            },
        } as const;

        const encryption = await createEncryptionFromAuthCredentials(credentials);

        const dataKey = Uint8Array.from({ length: 32 }, (_, index) => 64 - index);
        const encrypted = await encryption.encryptEncryptionKey(dataKey);
        const decrypted = await encryption.decryptEncryptionKey(encodeBase64(encrypted, 'base64'));

        expect(decrypted).not.toBeNull();
        expect(Array.from(decrypted!)).toEqual(Array.from(dataKey));
    });

    it('uses machineKey data-key encryption as machine fallback when machine data key cannot be decrypted', async () => {
        const machineKey = new Uint8Array(32).fill(13);
        const keyPair = sodium.crypto_box_keypair();

        const credentials = {
            token: 'token-test',
            encryption: {
                publicKey: encodeBase64(keyPair.publicKey),
                machineKey: encodeBase64(machineKey),
            },
        } as const;

        const encryption = await createEncryptionFromAuthCredentials(credentials);
        await encryption.initializeMachines(new Map([['machine-1', null]]));
        const machineEncryption = encryption.getMachineEncryption('machine-1');
        expect(machineEncryption).not.toBeNull();

        const expectedPayload = { type: 'success', sessionId: 'session-123' };
        const aes = new AES256Encryption(machineKey);
        const encryptedPayload = await aes.encrypt([expectedPayload]);
        const decryptedPayload = await machineEncryption!.decryptRaw(encodeBase64(encryptedPayload[0], 'base64'));

        expect(decryptedPayload).toEqual(expectedPayload);
    });
});
