import { afterEach, describe, expect, it, vi } from 'vitest';

import { openAes256GcmBytes, sealAes256GcmBytes } from './aes256GcmBytes';

describe('UI AES-256-GCM byte adapter', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('matches the peer-application cross-runtime golden vector and rejects modified ciphertext', async () => {
        const key = Uint8Array.from({ length: 32 }, (_, index) => index);
        const nonce = Uint8Array.from([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
        const aad = new TextEncoder().encode('{"accountId":"account-1","applicationAttemptId":"attempt-1","applicationAuthorityDigest":"sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","applicationKind":"speech_transcription","authorityDigest":"sha256:acdb52b3d7de70428b1c54fbb340ab675b98d6900d2b86ababad20baa7aed6ca","direction":"client_to_daemon","domain":"happier.peer-application.aead","flowKind":"voice_media","generation":7,"machineId":"machine-1","phase":"data","sequence":9,"streamId":"stream-1","substreamId":"daemon.voiceInference.stt.stream-1.7","suite":"aes-256-gcm","tunnelId":"tunnel-1","v":1}');
        const ciphertext = await sealAes256GcmBytes({ key, nonce, aad, plaintext: Uint8Array.from([0, 1, 2, 3, 255]) });
        expect([...ciphertext]).toEqual([184, 22, 251, 166, 56, 191, 136, 236, 62, 246, 17, 30, 125, 83, 170, 216, 152, 88, 7, 236, 72]);
        await expect(openAes256GcmBytes({ key, nonce, aad, ciphertext })).resolves.toEqual(Uint8Array.from([0, 1, 2, 3, 255]));
        ciphertext[0] ^= 1;
        await expect(openAes256GcmBytes({ key, nonce, aad, ciphertext })).rejects.toThrow('aes_256_gcm_authentication_failed');
    });

    it('passes whole owned ArrayBuffers to WebCrypto without duplicating their bytes', async () => {
        const key = new Uint8Array(32).fill(1);
        const nonce = new Uint8Array(12).fill(2);
        const aad = new Uint8Array(24).fill(3);
        const ciphertext = new Uint8Array(48).fill(4);
        let importedKeyData: BufferSource = new ArrayBuffer(0);
        let decryptAlgorithm: AesGcmParams = { name: 'AES-GCM', iv: new ArrayBuffer(0) };
        let decryptData: BufferSource = new ArrayBuffer(0);
        const importKey = vi.fn(async (...args: unknown[]) => {
            importedKeyData = args[1] as BufferSource;
            return {} as CryptoKey;
        });
        const decrypt = vi.fn(async (...args: unknown[]) => {
            decryptAlgorithm = args[0] as AesGcmParams;
            decryptData = args[2] as BufferSource;
            return new Uint8Array([9, 8, 7]).buffer;
        });
        vi.stubGlobal('crypto', {
            subtle: { importKey, decrypt },
        } as unknown as Crypto);

        await expect(openAes256GcmBytes({ key, nonce, aad, ciphertext })).resolves.toEqual(new Uint8Array([9, 8, 7]));

        expect(importedKeyData).toBe(key.buffer);
        expect(decryptAlgorithm.iv).toBe(nonce.buffer);
        expect(decryptAlgorithm.additionalData).toBe(aad.buffer);
        expect(decryptData).toBe(ciphertext.buffer);
    });

    it('copies subarray and SharedArrayBuffer views before passing them to WebCrypto', async () => {
        const keyBacking = new Uint8Array(34).fill(90);
        const nonceBacking = new Uint8Array(14).fill(91);
        const aadBacking = new Uint8Array(10).fill(92);
        const ciphertextBacking = typeof SharedArrayBuffer === 'function'
            ? new Uint8Array(new SharedArrayBuffer(50))
            : new Uint8Array(50);
        const key = keyBacking.subarray(1, 33).fill(1);
        const nonce = nonceBacking.subarray(1, 13).fill(2);
        const aad = aadBacking.subarray(1, 9).fill(3);
        const ciphertext = ciphertextBacking.subarray(1, 49).fill(4);
        let importedKeyData: BufferSource = new ArrayBuffer(0);
        let decryptAlgorithm: AesGcmParams = { name: 'AES-GCM', iv: new ArrayBuffer(0) };
        let decryptData: BufferSource = new ArrayBuffer(0);
        const importKey = vi.fn(async (...args: unknown[]) => {
            importedKeyData = args[1] as BufferSource;
            return {} as CryptoKey;
        });
        const decrypt = vi.fn(async (...args: unknown[]) => {
            decryptAlgorithm = args[0] as AesGcmParams;
            decryptData = args[2] as BufferSource;
            return new Uint8Array([5]).buffer;
        });
        vi.stubGlobal('crypto', {
            subtle: { importKey, decrypt },
        } as unknown as Crypto);

        await expect(openAes256GcmBytes({ key, nonce, aad, ciphertext })).resolves.toEqual(new Uint8Array([5]));

        expect(importedKeyData).not.toBe(key.buffer);
        expect(decryptAlgorithm.iv).not.toBe(nonce.buffer);
        expect(decryptAlgorithm.additionalData).not.toBe(aad.buffer);
        expect(decryptData).not.toBe(ciphertext.buffer);
        expect([...new Uint8Array(importedKeyData as ArrayBuffer)]).toEqual([...key]);
        expect([...new Uint8Array(decryptAlgorithm.iv as ArrayBuffer)]).toEqual([...nonce]);
        expect([...new Uint8Array(decryptAlgorithm.additionalData as ArrayBuffer)]).toEqual([...aad]);
        expect([...new Uint8Array(decryptData as ArrayBuffer)]).toEqual([...ciphertext]);
    });

    it('rejects a detached whole ArrayBuffer before invoking WebCrypto encryption', async () => {
        const key = new Uint8Array(32).fill(1);
        const nonce = new Uint8Array(12).fill(2);
        const aad = new Uint8Array(8).fill(3);
        const plaintext = new Uint8Array([4, 5, 6]);
        structuredClone(plaintext.buffer, { transfer: [plaintext.buffer] });
        const importKey = vi.fn(async () => ({} as CryptoKey));
        const encrypt = vi.fn(async () => new ArrayBuffer(0));
        vi.stubGlobal('crypto', {
            subtle: { importKey, encrypt },
        } as unknown as Crypto);

        await expect(sealAes256GcmBytes({ key, nonce, aad, plaintext })).rejects.toThrow('aes_256_gcm_invalid_parameters');
        expect(importKey).toHaveBeenCalledOnce();
        expect(encrypt).not.toHaveBeenCalled();
    });
});
