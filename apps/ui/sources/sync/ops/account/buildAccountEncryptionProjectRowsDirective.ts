import { AccountEncryptionMigrateProjectRowsDirectiveSchema, type AccountEncryptionMigrateProjectRowsDirective } from '@happier-dev/protocol/account/encryptionMigrate';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ProjectAccountRowPayloadV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

export type AccountEncryptionProjectRowMigrationCandidate = Readonly<{
    revision: number;
    payload: ProjectAccountRowPayloadV1;
}>;

export function buildAccountEncryptionProjectRowsDirective(params: Readonly<{
    candidates: readonly AccountEncryptionProjectRowMigrationCandidate[];
    target: Readonly<{ mode: 'plain' }> | Readonly<{ mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array }>;
}>): AccountEncryptionMigrateProjectRowsDirective | undefined {
    if (params.candidates.length === 0) return undefined;
    const cipher = createProjectAccountRowCipherV1({ mode: params.target.mode,
        material: params.target.mode === 'plain' ? null : params.target.material,
        randomBytes: params.target.mode === 'plain' ? () => { throw new Error('Plain Project rows do not require randomness'); } : params.target.randomBytes,
    });
    return AccountEncryptionMigrateProjectRowsDirectiveSchema.parse({ items: params.candidates.map(row => ({
        key: row.payload.key, expectedRevision: row.revision, content: cipher.seal(row.payload),
    })) });
}
