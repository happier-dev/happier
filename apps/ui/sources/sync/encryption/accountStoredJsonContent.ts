import {
    decodeBase64StoredJsonContentEnvelope,
    encodeBase64StoredJsonContentEnvelope,
} from './base64StoredJsonContent';

type RawAccountEncryption = Readonly<{
    encryptRaw: (value: unknown) => Promise<string>;
    decryptRaw: (value: string) => Promise<unknown>;
}>;

export class AccountStoredJsonContentEncryptionMaterialUnavailableError extends Error {
    readonly code = 'account_stored_json_encryption_material_unavailable';

    constructor() {
        super('Account encryption material is unavailable for encrypted content');
        this.name =
            'AccountStoredJsonContentEncryptionMaterialUnavailableError';
    }
}

export async function encodeAccountStoredJsonContent(params: Readonly<{
    mode: 'plain' | 'e2ee';
    value: unknown;
    encryption: RawAccountEncryption | null;
}>): Promise<string> {
    if (params.mode === 'plain') {
        return encodeBase64StoredJsonContentEnvelope({
            t: 'plain',
            v: params.value,
        });
    }
    if (!params.encryption) {
        throw new AccountStoredJsonContentEncryptionMaterialUnavailableError();
    }
    // Preserve the released ciphertext-only representation. The reader also accepts the
    // canonical envelope so a future wire migration can be staged independently.
    return await params.encryption.encryptRaw(params.value);
}

export async function decodeAccountStoredJsonContent(params: Readonly<{
    encoded: string;
    encryption: Pick<RawAccountEncryption, 'decryptRaw'> | null;
}>): Promise<unknown> {
    const envelope = decodeBase64StoredJsonContentEnvelope(params.encoded);

    if (envelope?.t === 'plain') {
        return envelope.v;
    }

    if (!params.encryption) {
        throw new AccountStoredJsonContentEncryptionMaterialUnavailableError();
    }
    return await params.encryption.decryptRaw(
        envelope?.t === 'encrypted' ? envelope.c : params.encoded,
    );
}
