import { sealAcpCatalogMigrationContentV1, type AcpCatalogRecordV1, type AcpCatalogMigrationSourceV1,
  type AccountEncryptionMigrateAcpCatalogDirectiveV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

export type AccountEncryptionAcpCatalogMigrationCandidate = Readonly<{ revision: number; record: null }>
  | Readonly<{ revision: number; record: AcpCatalogRecordV1; migrationSource: AcpCatalogMigrationSourceV1 }>;

/** Conversion retains the genuine predecessor root, including its exact absence. */
export function restoreAccountEncryptionAcpCatalogSettingsSource(params: Readonly<{
  settings: Readonly<object>; rawSettings: Readonly<Record<string, unknown>>;
}>): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...params.settings };
  if (Object.hasOwn(params.rawSettings, 'acpCatalogSettingsV1')) settings.acpCatalogSettingsV1 = params.rawSettings.acpCatalogSettingsV1;
  else delete settings.acpCatalogSettingsV1;
  return settings;
}

export function buildAccountEncryptionAcpCatalogDirective(params: Readonly<{
  candidate?: AccountEncryptionAcpCatalogMigrationCandidate;
  target: Readonly<{ mode: 'plain' }> | Readonly<{
    mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
  }>;
}>): AccountEncryptionMigrateAcpCatalogDirectiveV1 | undefined {
  if (!params.candidate) return undefined;
  return { expectedRevision: params.candidate.revision, content: params.candidate.record === null ? null
    : sealAcpCatalogMigrationContentV1({ source: params.candidate.migrationSource, mode: params.target.mode,
      material: params.target.mode === 'plain' ? null : params.target.material,
      ...(params.target.mode === 'e2ee' ? { randomBytes: params.target.randomBytes } : {}),
    }) };
}
