import { describe, expect, it, vi } from 'vitest';

import type { Decryptor, Encryptor } from './encryptor';
import { EncryptionCache } from './encryptionCache';
import { SessionEncryption } from './sessionEncryption';

type Base64DecryptFn = (data: readonly string[]) => Promise<(unknown | null)[]>;

function createBase64Decryptor(
    decryptBase64: Base64DecryptFn,
): Encryptor & Decryptor & { decryptBase64: Base64DecryptFn } {
    return {
        encrypt: async () => {
            throw new Error('encrypt should not be called');
        },
        decrypt: async () => {
            throw new Error('decrypt should not be called when decryptBase64 is available');
        },
        decryptBase64,
    };
}

describe('SessionEncryption metadata in-flight dedupe', () => {
    it('shares concurrent metadata decrypts for the same session version and ciphertext', async () => {
        const metadata = { path: '/repo', host: 'machine' };
        let releaseDecrypt: () => void = () => {};
        const decryptBase64 = vi.fn<Base64DecryptFn>(async () => {
            await new Promise<void>((resolve) => {
                releaseDecrypt = resolve;
            });
            return [metadata];
        });
        const sessionEncryption = new SessionEncryption(
            'session-1',
            createBase64Decryptor(decryptBase64),
            new EncryptionCache(),
        );

        const first = sessionEncryption.decryptMetadata(1, 'ciphertext-a');
        const second = sessionEncryption.decryptMetadata(1, 'ciphertext-a');

        expect(decryptBase64).toHaveBeenCalledTimes(1);
        releaseDecrypt();
        await expect(Promise.all([first, second])).resolves.toEqual([metadata, metadata]);
    });

    it('shares concurrent agent-state decrypts for the same session version and ciphertext', async () => {
        const agentState = { controlledByUser: true };
        let releaseDecrypt: () => void = () => {};
        const decryptBase64 = vi.fn<Base64DecryptFn>(async () => {
            await new Promise<void>((resolve) => {
                releaseDecrypt = resolve;
            });
            return [agentState];
        });
        const sessionEncryption = new SessionEncryption(
            'session-1',
            createBase64Decryptor(decryptBase64),
            new EncryptionCache(),
        );

        const first = sessionEncryption.decryptAgentState(2, 'ciphertext-b');
        const second = sessionEncryption.decryptAgentState(2, 'ciphertext-b');

        expect(decryptBase64).toHaveBeenCalledTimes(1);
        releaseDecrypt();
        await expect(Promise.all([first, second])).resolves.toEqual([agentState, agentState]);
    });

    it('retries metadata decrypt after an in-flight decrypt rejects', async () => {
        const metadata = { path: '/repo', host: 'machine' };
        const decryptBase64 = vi
            .fn<Base64DecryptFn>()
            .mockRejectedValueOnce(new Error('decrypt failed'))
            .mockResolvedValueOnce([metadata]);
        const sessionEncryption = new SessionEncryption(
            'session-1',
            createBase64Decryptor(decryptBase64),
            new EncryptionCache(),
        );

        const first = sessionEncryption.decryptMetadata(1, 'ciphertext-a');
        const second = sessionEncryption.decryptMetadata(1, 'ciphertext-a');

        await expect(Promise.all([first, second])).rejects.toThrow('decrypt failed');
        await expect(sessionEncryption.decryptMetadata(1, 'ciphertext-a')).resolves.toEqual(metadata);
        expect(decryptBase64).toHaveBeenCalledTimes(2);
    });

    it('shares concurrent snapshot-state decrypts for the same session versions and ciphertexts', async () => {
        const metadata = { path: '/repo', host: 'machine' };
        const agentState = { controlledByUser: true };
        let releaseDecrypt: () => void = () => {};
        const decryptBase64 = vi.fn<Base64DecryptFn>(async () => {
            await new Promise<void>((resolve) => {
                releaseDecrypt = resolve;
            });
            return [metadata, agentState];
        });
        const sessionEncryption = new SessionEncryption(
            'session-1',
            createBase64Decryptor(decryptBase64),
            new EncryptionCache(),
        );

        const first = sessionEncryption.decryptSessionSnapshotState(1, 'ciphertext-a', 2, 'ciphertext-b');
        const second = sessionEncryption.decryptSessionSnapshotState(1, 'ciphertext-a', 2, 'ciphertext-b');

        expect(decryptBase64).toHaveBeenCalledTimes(1);
        releaseDecrypt();
        await expect(Promise.all([first, second])).resolves.toEqual([
            { metadata, agentState },
            { metadata, agentState },
        ]);
    });

    it('does not share metadata decrypts across session encryption instances', async () => {
        const firstMetadata = { path: '/repo-a', host: 'machine-a' };
        const secondMetadata = { path: '/repo-b', host: 'machine-b' };
        const firstDecryptBase64 = vi.fn<Base64DecryptFn>(async () => [firstMetadata]);
        const secondDecryptBase64 = vi.fn<Base64DecryptFn>(async () => [secondMetadata]);
        const firstSessionEncryption = new SessionEncryption(
            'session-1',
            createBase64Decryptor(firstDecryptBase64),
            new EncryptionCache(),
        );
        const secondSessionEncryption = new SessionEncryption(
            'session-1',
            createBase64Decryptor(secondDecryptBase64),
            new EncryptionCache(),
        );

        await expect(Promise.all([
            firstSessionEncryption.decryptMetadata(1, 'ciphertext-a'),
            secondSessionEncryption.decryptMetadata(1, 'ciphertext-a'),
        ])).resolves.toEqual([firstMetadata, secondMetadata]);
        expect(firstDecryptBase64).toHaveBeenCalledTimes(1);
        expect(secondDecryptBase64).toHaveBeenCalledTimes(1);
    });
});
