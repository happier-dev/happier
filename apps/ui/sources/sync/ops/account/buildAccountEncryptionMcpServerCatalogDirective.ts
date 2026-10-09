import { AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema, sealMcpServerCatalogMigrationContentV1,
  type AccountEncryptionMigrateMcpServerCatalogDirectiveV1, type McpServerCatalogV1,
  type McpServerCatalogMigrationSourceV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

export type AccountEncryptionMcpServerCatalogMigrationCandidate = Readonly<{ revision: number; catalog: null }>
  | Readonly<{ revision: number; catalog: McpServerCatalogV1; migrationSource: McpServerCatalogMigrationSourceV1 }>;

/** Conversion must preserve actual retained source bytes, including source absence. */
export function restoreAccountEncryptionMcpServerCatalogSettingsSource(input: Readonly<{
  settings: Readonly<object>; rawSettings: Readonly<Record<string, unknown>>;
}>): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...input.settings };
  if (Object.hasOwn(input.rawSettings, 'mcpServersSettingsV1')) settings.mcpServersSettingsV1 = input.rawSettings.mcpServersSettingsV1;
  else delete settings.mcpServersSettingsV1;
  return settings;
}

/** A deleted catalog remains authoritative and keeps its incumbent tombstone revision. */
export function buildAccountEncryptionMcpServerCatalogDirective(params: Readonly<{
  candidate?: AccountEncryptionMcpServerCatalogMigrationCandidate;
  target: Readonly<{ mode: 'plain' }> | Readonly<{
    mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
  }>;
}>): AccountEncryptionMigrateMcpServerCatalogDirectiveV1 | undefined {
  if (!params.candidate) return undefined;
  return AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema.parse({
    expectedRevision: params.candidate.revision,
    content: params.candidate.catalog === null ? null : sealMcpServerCatalogMigrationContentV1({
      source: params.candidate.migrationSource, mode: params.target.mode,
      material: params.target.mode === 'plain' ? null : params.target.material,
      ...(params.target.mode === 'e2ee' ? { randomBytes: params.target.randomBytes } : {}),
    }),
  });
}
