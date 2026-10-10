import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AccountEncryptionMigrateProviderConnectionsDirectiveV1Schema,
  type AccountEncryptionMigrateProviderConnectionsDirectiveV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { sealProviderConnectionsMigrationContentV1, type ProviderConnectionsMigrationSourceV1,
  type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

export type AccountEncryptionProviderConnectionsMigrationCandidate = Readonly<{ revision: number }> & (
  Readonly<{ catalog: null }> | Readonly<{ catalog: ProviderConnectionsCatalogV1; migrationSource: ProviderConnectionsMigrationSourceV1 }>
);

/** A deleted catalog participates in coverage without becoming a new live row. */
export function buildAccountEncryptionProviderConnectionsDirective(params: Readonly<{
  candidate?: AccountEncryptionProviderConnectionsMigrationCandidate;
  target: Readonly<{ mode: 'plain' }> | Readonly<{ mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array }>;
}>): AccountEncryptionMigrateProviderConnectionsDirectiveV1 | undefined {
  if (!params.candidate) return undefined;
  return AccountEncryptionMigrateProviderConnectionsDirectiveV1Schema.parse({
    expectedRevision: params.candidate.revision,
    content: params.candidate.catalog === null ? null : sealProviderConnectionsMigrationContentV1({
      source: params.candidate.migrationSource, mode: params.target.mode,
      material: params.target.mode === 'plain' ? null : params.target.material,
      ...(params.target.mode === 'e2ee' ? { randomBytes: params.target.randomBytes } : {}),
    }),
  });
}
