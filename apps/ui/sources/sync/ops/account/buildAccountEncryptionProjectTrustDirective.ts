import { AccountEncryptionMigrateProjectTrustDirectiveSchema, type AccountEncryptionMigrateProjectTrustDirective } from '@happier-dev/protocol/account/encryptionMigrate';
import { sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { assertProjectTrustValueForProjectV1, ProjectTrustValueV1Schema, type ProjectTrustValueV1, type QualifiedProjectTrustProjectV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';

export type AccountEncryptionProjectTrustMigrationCandidate = Readonly<{ project: QualifiedProjectTrustProjectV1; revision: number; value: ProjectTrustValueV1 }>;

export function buildAccountEncryptionProjectTrustDirective(params: Readonly<{
  candidates: readonly AccountEncryptionProjectTrustMigrationCandidate[];
  target: Readonly<{ mode: 'plain' }> | Readonly<{ mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array }>;
}>): AccountEncryptionMigrateProjectTrustDirective | undefined {
  if (params.candidates.length === 0) return undefined;
  const target = params.target;
  return AccountEncryptionMigrateProjectTrustDirectiveSchema.parse({ items: params.candidates.map(row => {
    const value = ProjectTrustValueV1Schema.parse(assertProjectTrustValueForProjectV1(row.value, row.project));
    return { project: row.project, expectedRevision: row.revision, content: target.mode === 'plain' ? { t: 'plain', v: value } : {
      t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'project_setup_trust', material: target.material, payload: value, randomBytes: target.randomBytes }),
    } };
  }) });
}
