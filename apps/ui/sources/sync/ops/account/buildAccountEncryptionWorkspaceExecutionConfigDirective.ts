import { AccountEncryptionMigrateWorkspaceExecutionConfigDirectiveSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { WorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { sealWorkspaceExecutionConfigContentV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';

export type AccountEncryptionWorkspaceExecutionConfigMigrationCandidate = Readonly<{
  rowId: string; revision: number; value: WorkspaceExecutionSettingsV1;
}>;

export function buildAccountEncryptionWorkspaceExecutionConfigDirective(params: Readonly<{
  candidates: readonly AccountEncryptionWorkspaceExecutionConfigMigrationCandidate[];
  target: Readonly<{ mode: 'plain' }> | Readonly<{
    mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
  }>;
}>) {
  if (params.candidates.length === 0) return undefined;
  return AccountEncryptionMigrateWorkspaceExecutionConfigDirectiveSchema.parse({
    items: params.candidates.map((row) => ({
      rowId: row.rowId, expectedRevision: row.revision,
      content: sealWorkspaceExecutionConfigContentV1({
        rowId: row.rowId, value: row.value, mode: params.target.mode,
        material: params.target.mode === 'plain' ? null : params.target.material,
        randomBytes: params.target.mode === 'plain'
          ? () => { throw new Error('plain_workspace_execution_config_randomness_unavailable'); }
          : params.target.randomBytes,
      }),
    })),
  });
}
