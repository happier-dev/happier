import { describe, it, expect } from 'vitest';
import { KeyTree } from "./keyTree";
import { encodeUTF8 } from '../formats/text';
import { deriveSecretKeyTreeRoot } from '../crypto/deriveKey';
import { decodeHex, encodeHex } from '../formats/hex';

describe('keyTree', () => {

    const testVectors = [
        {
            seed: encodeUTF8('some test seed'),
            usage: 'test usage',
            path: ['child1', 'child2'],
            encrypted: '0033930C22DD4609D03AD1F9B9FB4770AF015E718AB7AFB7D661D356770EE8AC25',
            symmetricKey1: 'F0F068E3D385210FF36440342EA073EDA97C7592B58A13A7C6CDF5448B789669',
            symmetricKey2: 'B632B72A54C4E8C4735D27954BB1385395F6FEB003B8BFD6C3FAAE57C238F454',
        }
    ]

    it('should work with test vectors', async () => {
        for (let v of testVectors) {
            const keyTree = new KeyTree(deriveSecretKeyTreeRoot(v.seed, v.usage).chainCode);
            const key1 = keyTree.deriveSymmetricKey([v.path[0]]);
            const key2 = keyTree.deriveSymmetricKey([v.path[0], v.path[1]]);
            expect(encodeHex(key1)).toEqual(v.symmetricKey1);
            expect(encodeHex(key2)).toEqual(v.symmetricKey2);
            const encrypted = await keyTree.symmetricEncrypt(v.path, 'test');
            const decrypted = await keyTree.symmetricDecryptString(v.path, encrypted);
            const decrypted2 = await keyTree.symmetricDecryptString(v.path, decodeHex(v.encrypted));
            expect(decrypted).toEqual('test');
            expect(decrypted2).toEqual('test');
            expect(encrypted).not.toEqual(decodeHex(v.encrypted));
        }
    });

    it('should encrypt and decrypt', async () => {
        const keyTree = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const encrypted = await keyTree.symmetricEncrypt(['test'], 'test');
        const decrypted = await keyTree.symmetricDecryptString(['test'], encrypted);
        expect(decrypted).toEqual('test');
    });

    it('should detect tampering with encrypted data', async () => {
        const keyTree = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const encrypted = await keyTree.symmetricEncrypt(['test'], 'test');

        // Tamper with the encrypted data
        encrypted[20] = encrypted[20] ^ 1; // Flip one bit in the ciphertext

        await expect(async () => {
            await keyTree.symmetricDecryptString(['test'], encrypted);
        }).rejects.toThrow();
    });

    it('should reject invalid data format', async () => {
        const keyTree = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const invalidData = Buffer.from('invalid data');

        await expect(async () => {
            await keyTree.symmetricDecryptString(['test'], invalidData);
        }).rejects.toThrow('Invalid data');
    });

    it('should not decrypt with wrong key path', async () => {
        const keyTree = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const encrypted = await keyTree.symmetricEncrypt(['path1'], 'test');

        await expect(async () => {
            await keyTree.symmetricDecryptString(['wrong-path'], encrypted);
        }).rejects.toThrow();
    });

    it('should derive different keys for different paths', async () => {
        const keyTree = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const data = 'test';

        const encrypted1 = await keyTree.symmetricEncrypt(['path1'], data);
        const encrypted2 = await keyTree.symmetricEncrypt(['path2'], data);

        // Encrypted data should be different due to different keys and random nonce
        expect(encrypted1).not.toEqual(encrypted2);

        // But both should decrypt correctly with their respective paths
        const decrypted1 = await keyTree.symmetricDecryptString(['path1'], encrypted1);
        const decrypted2 = await keyTree.symmetricDecryptString(['path2'], encrypted2);

        expect(decrypted1).toEqual(data);
        expect(decrypted2).toEqual(data);
    });

    it('should produce different ciphertexts for same data and path', async () => {
        const keyTree = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const data = 'test';
        const path = ['test-path'];

        // Encrypt the same data multiple times
        const encrypted1 = await keyTree.symmetricEncrypt(path, data);
        const encrypted2 = await keyTree.symmetricEncrypt(path, data);
        const encrypted3 = await keyTree.symmetricEncrypt(path, data);

        // All encryptions should be different due to random nonce
        expect(encrypted1).not.toEqual(encrypted2);
        expect(encrypted2).not.toEqual(encrypted3);
        expect(encrypted1).not.toEqual(encrypted3);

        // But they should all decrypt to the same original data
        const decrypted1 = await keyTree.symmetricDecryptString(path, encrypted1);
        const decrypted2 = await keyTree.symmetricDecryptString(path, encrypted2);
        const decrypted3 = await keyTree.symmetricDecryptString(path, encrypted3);

        expect(decrypted1).toEqual(data);
        expect(decrypted2).toEqual(data);
        expect(decrypted3).toEqual(data);
    });

    it('should derive consistent symmetric keys for the same path', async () => {
        const keyTree1 = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const keyTree2 = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const path = ['test', 'path'];

        const key1 = keyTree1.deriveSymmetricKey(path);
        const key2 = keyTree2.deriveSymmetricKey(path);

        expect(key1).toEqual(key2);
        expect(key1).toMatchSnapshot();
    });

    it('should derive consistent Curve25519 keys for the same path', async () => {
        const keyTree1 = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const keyTree2 = new KeyTree(deriveSecretKeyTreeRoot("test", "testcase").chainCode);
        const path = ['test', 'path'];

        const keypair1 = keyTree1.deriveCurve25519Key(path);
        const keypair2 = keyTree2.deriveCurve25519Key(path);

        expect(keypair1.secret).toEqual(keypair2.secret);
        expect(keypair1.public).toEqual(keypair2.public);
        expect(keypair1).toMatchSnapshot();
    });

    it('should derive different keys for different usages', async () => {
        const keyTree1 = new KeyTree(deriveSecretKeyTreeRoot("test", "usage1").chainCode);
        const keyTree2 = new KeyTree(deriveSecretKeyTreeRoot("test", "usage2").chainCode);
        const path = ['test', 'path'];

        const key1 = keyTree1.deriveSymmetricKey(path);
        const key2 = keyTree2.deriveSymmetricKey(path);

        expect(key1).not.toEqual(key2);
    });
});