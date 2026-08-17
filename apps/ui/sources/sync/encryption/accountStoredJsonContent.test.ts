import { describe, expect, it, vi } from 'vitest';

import {
    AccountStoredJsonContentEncryptionMaterialUnavailableError,
    decodeAccountStoredJsonContent,
    encodeAccountStoredJsonContent,
} from './accountStoredJsonContent';
import {
    decodeBase64StoredJsonContentEnvelope,
    encodeBase64StoredJsonContentEnvelope,
} from './base64StoredJsonContent';

describe('accountStoredJsonContent', () => {
    it('stores plaintext account data without consulting account encryption material', async () => {
        const encryption = {
            encryptRaw: vi.fn(),
            decryptRaw: vi.fn(),
        };

        const encoded = await encodeAccountStoredJsonContent({
            mode: 'plain',
            value: { title: 'plain task' },
            encryption,
        });

        expect(decodeBase64StoredJsonContentEnvelope(encoded)).toEqual({
            t: 'plain',
            v: { title: 'plain task' },
        });
        expect(encryption.encryptRaw).not.toHaveBeenCalled();
        await expect(decodeAccountStoredJsonContent({
            encoded,
            encryption: null,
        })).resolves.toEqual({ title: 'plain task' });
    });

    it('preserves the released raw encrypted representation for e2ee writes and reads', async () => {
        const encryption = {
            encryptRaw: vi.fn(async () => 'released-ciphertext'),
            decryptRaw: vi.fn(async () => ({ title: 'encrypted task' })),
        };

        await expect(encodeAccountStoredJsonContent({
            mode: 'e2ee',
            value: { title: 'encrypted task' },
            encryption,
        })).resolves.toBe('released-ciphertext');

        await expect(decodeAccountStoredJsonContent({
            encoded: 'released-ciphertext',
            encryption,
        })).resolves.toEqual({ title: 'encrypted task' });
        expect(encryption.decryptRaw).toHaveBeenCalledWith(
            'released-ciphertext',
        );
    });

    it('decrypts the ciphertext inside a canonical encrypted envelope', async () => {
        const encryption = {
            decryptRaw: vi.fn(async (ciphertext: string) =>
                ciphertext === 'canonical-ciphertext'
                    ? { title: 'migrated encrypted task' }
                    : null),
        };
        const encoded = encodeBase64StoredJsonContentEnvelope({
            t: 'encrypted',
            c: 'canonical-ciphertext',
        });

        await expect(decodeAccountStoredJsonContent({
            encoded,
            encryption,
        })).resolves.toEqual({ title: 'migrated encrypted task' });
        expect(encryption.decryptRaw).toHaveBeenCalledWith(
            'canonical-ciphertext',
        );
    });

    it('fails closed when encrypted content has no account encryption material', async () => {
        await expect(decodeAccountStoredJsonContent({
            encoded: 'released-ciphertext',
            encryption: null,
        })).rejects.toBeInstanceOf(
            AccountStoredJsonContentEncryptionMaterialUnavailableError,
        );
    });
});
