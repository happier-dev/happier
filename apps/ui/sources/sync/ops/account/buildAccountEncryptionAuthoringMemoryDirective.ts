import { AccountEncryptionMigrateAuthoringMemoryDirectiveSchema, type AccountEncryptionMigrateAuthoringMemoryDirective } from '@happier-dev/protocol/account/encryptionMigrate';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AuthoringMemoryValueV1 } from '@happier-dev/protocol/account/authoringMemory';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';

export type AccountEncryptionAuthoringMemoryMigrationCandidate = Readonly<{
  key: string;
  revision: number;
  value: AuthoringMemoryValueV1;
}>;

export function buildAccountEncryptionAuthoringMemoryDirective(params: Readonly<{
  candidates: readonly AccountEncryptionAuthoringMemoryMigrationCandidate[];
  target: Readonly<{ mode: 'plain' }> | Readonly<{
    mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
  }>;
}>): AccountEncryptionMigrateAuthoringMemoryDirective | undefined {
  if (params.candidates.length === 0) return undefined;
  const cipher = createAuthoringMemoryCipher({
    mode: params.target.mode,
    material: params.target.mode === 'plain' ? null : params.target.material,
    randomBytes: params.target.mode === 'plain'
      ? () => { throw new Error('Plain authoring memory does not require randomness'); }
      : params.target.randomBytes,
  });
  return AccountEncryptionMigrateAuthoringMemoryDirectiveSchema.parse({
    items: params.candidates.map((row) => ({
      key: row.key, expectedRevision: row.revision, content: cipher.seal(row.key, row.value),
    })),
  });
}
