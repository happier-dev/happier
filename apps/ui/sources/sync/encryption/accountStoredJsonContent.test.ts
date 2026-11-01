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
import { Encryption } from './encryption';

describe('accountStoredJsonContent', () => {
    it('rejects content from the other Account mode before decryption or disclosure', async () => {
        const encryption = { decryptRaw: vi.fn(async () => ({ private: true })) };
        await expect(decodeAccountStoredJsonContent({
            encoded: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { private: true } }),
            encryption,
            expectedMode: 'e2ee',
        })).rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
        await expect(decodeAccountStoredJsonContent({
            encoded: 'released-ciphertext',
            encryption,
            expectedMode: 'plain',
        })).rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
        expect(encryption.decryptRaw).not.toHaveBeenCalled();
    });

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

    it('roundtrips e2ee content as raw ciphertext readable only by its Account', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(11));
        const otherAccount = await Encryption.create(new Uint8Array(32).fill(12));
        const value = { title: 'encrypted task' };
        const encoded = await encodeAccountStoredJsonContent({
            mode: 'e2ee',
            value,
            encryption,
        });

        expect(decodeBase64StoredJsonContentEnvelope(encoded)).toBeNull();
        await expect(encryption.decryptRaw(encoded)).resolves.toEqual(value);
        await expect(decodeAccountStoredJsonContent({
            encoded,
            encryption,
        })).resolves.toEqual(value);
        await expect(decodeAccountStoredJsonContent({
            encoded,
            encryption: otherAccount,
        })).resolves.toBeNull();
    });

    it('decrypts the ciphertext inside a canonical encrypted envelope', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(13));
        const value = { title: 'migrated encrypted task' };
        const encoded = encodeBase64StoredJsonContentEnvelope({
            t: 'encrypted',
            c: await encryption.encryptRaw(value),
        });

        await expect(decodeAccountStoredJsonContent({
            encoded,
            encryption,
        })).resolves.toEqual(value);
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
