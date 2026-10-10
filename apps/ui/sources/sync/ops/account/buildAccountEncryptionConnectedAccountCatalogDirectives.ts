import type { AccountEncryptionMigrateRequest } from '@happier-dev/protocol/account/encryptionMigrate';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema,
  AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema, sealConnectedAccountCatalogMigrationContentV1,
  type ConnectedAccountCatalogMigrationSourceV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

/** Null is an admitted retained tombstone, never a failed source opening. */
export type AccountEncryptionConnectedAccountCatalogMigrationCandidate = Readonly<{
  revision: number; migrationSource: ConnectedAccountCatalogMigrationSourceV1 | null;
}>;
export type AccountEncryptionConnectedAccountCatalogMigrationCandidates = Readonly<{
  connectedConfigurations?: AccountEncryptionConnectedAccountCatalogMigrationCandidate;
  connectedPurposes?: AccountEncryptionConnectedAccountCatalogMigrationCandidate;
}>;
type Target = Readonly<{ mode: 'plain' }> | Readonly<{
  mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
}>;

export function buildAccountEncryptionConnectedAccountCatalogDirectives(
  candidates: AccountEncryptionConnectedAccountCatalogMigrationCandidates, target: Target,
): Pick<AccountEncryptionMigrateRequest, 'connectedConfigurations' | 'connectedPurposes'> {
  const directives: Pick<AccountEncryptionMigrateRequest, 'connectedConfigurations' | 'connectedPurposes'> = {};
  const sealTarget = { mode: target.mode, material: target.mode === 'plain' ? null : target.material,
    ...(target.mode === 'e2ee' ? { randomBytes: target.randomBytes } : {}) };
  for (const key of ['connectedConfigurations', 'connectedPurposes'] as const) {
    const candidate = candidates[key];
    if (!candidate) continue;
    const content = candidate.migrationSource === null ? null
      : sealConnectedAccountCatalogMigrationContentV1({ ...sealTarget, source: candidate.migrationSource });
    const schema = key === 'connectedConfigurations' ? AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema
      : AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema;
    directives[key] = schema.parse({ expectedRevision: candidate.revision, content });
  }
  return directives;
}
