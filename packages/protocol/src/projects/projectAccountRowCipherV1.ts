import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import {
    PROJECT_ACCOUNT_ROW_BLOB_KIND_V1,
    ProjectAccountRowPayloadV1Schema,
    assertProjectAccountRowContentForModeV1,
    assertProjectAccountRowPayloadBindingV1,
    type ProjectAccountRowContentV1,
    type ProjectAccountRowKeyV1,
    type ProjectAccountRowPayloadV1,
} from './projectAccountRowsV1.js';

export type ProjectAccountRowCipherV1 = Readonly<{
    seal(input: ProjectAccountRowPayloadV1): ProjectAccountRowContentV1;
    open(key: ProjectAccountRowKeyV1, input: ProjectAccountRowContentV1): ProjectAccountRowPayloadV1;
}>;

/** UI and CLI open the same bound payload under the persisted Account mode. */
export function createProjectAccountRowCipherV1(options: Readonly<{
    mode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    randomBytes(length: number): Uint8Array;
}>): ProjectAccountRowCipherV1 {
    if (options.mode === 'e2ee' && !options.material) {
        throw Object.assign(new Error('Project Account row encryption material is unavailable'),
            { code: 'project_account_encryption_material_unavailable' });
    }
    function material(): AccountScopedCryptoMaterial {
        if (!options.material) throw new Error('Project Account row encryption material is unavailable');
        return options.material;
    }
    return {
        seal(input: ProjectAccountRowPayloadV1): ProjectAccountRowContentV1 {
            const payload = ProjectAccountRowPayloadV1Schema.parse(input);
            return options.mode === 'plain' ? { t: 'plain', v: payload } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: PROJECT_ACCOUNT_ROW_BLOB_KIND_V1, material: material(), payload, randomBytes: options.randomBytes,
            }) };
        },
        open(key: ProjectAccountRowKeyV1, input: ProjectAccountRowContentV1): ProjectAccountRowPayloadV1 {
            const content = assertProjectAccountRowContentForModeV1(input, options.mode);
            return assertProjectAccountRowPayloadBindingV1(key, content.t === 'plain' ? content.v
                : openAccountScopedBlobCiphertext({ kind: PROJECT_ACCOUNT_ROW_BLOB_KIND_V1, material: material(), ciphertext: content.c })?.value);
        },
    };
}
