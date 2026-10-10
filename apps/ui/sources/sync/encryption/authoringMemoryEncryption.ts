import { assertAuthoringMemoryValueForKeyV1, AuthoringMemoryPrivatePayloadV1Schema, StoredAuthoringMemoryPrivatePayloadV1Schema, assertAuthoringMemoryContentForModeV1, AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1, type AuthoringMemoryContentV1, type AuthoringMemoryValueV1 } from '@happier-dev/protocol/account/authoringMemory';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

export type AuthoringMemoryCipher = Readonly<{
    seal(key: string, value: AuthoringMemoryValueV1): AuthoringMemoryContentV1;
    open(key: string, content: AuthoringMemoryContentV1): AuthoringMemoryValueV1;
}>;

export class AuthoringMemoryUnavailableError extends Error {
    readonly code = 'authoring_memory_unavailable';
    constructor(message: string) { super(message); this.name = 'AuthoringMemoryUnavailableError'; }
}

/** The Account's persisted mode is supplied by the currentness owner, never inferred from keys. */
export function createAuthoringMemoryCipher(options: Readonly<{
    mode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    randomBytes(length: number): Uint8Array;
}>): AuthoringMemoryCipher {
    function material(): AccountScopedCryptoMaterial {
        if (!options.material) throw new AuthoringMemoryUnavailableError('Account authoring memory encryption material is unavailable');
        return options.material;
    }
    return {
        seal: (key, value) => options.mode === 'plain'
            ? { t: 'plain', v: assertAuthoringMemoryValueForKeyV1(key, value) }
            : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1,
                material: material(),
                payload: AuthoringMemoryPrivatePayloadV1Schema.parse({ key, value }),
                randomBytes: options.randomBytes,
            }) },
        open: (key, envelope) => {
            const content = assertAuthoringMemoryContentForModeV1(envelope, options.mode, key);
            if (content.t === 'plain') return content.v;
            const opened = openAccountScopedBlobCiphertext({
                kind: AUTHORING_MEMORY_ACCOUNT_SCOPED_BLOB_KIND_V1,
                material: material(), ciphertext: content.c,
            });
            const parsed = StoredAuthoringMemoryPrivatePayloadV1Schema.safeParse(opened?.value);
            if (!parsed.success || parsed.data.key !== key) {
                throw new AuthoringMemoryUnavailableError('Account authoring memory row cannot be opened');
            }
            return parsed.data.value;
        },
    };
}
