import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createWorkspaceExecutionConfigApiV1 } from '@/sync/api/workspaces/workspaceExecutionConfig';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { openWorkspaceExecutionConfigContentV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import type { AccountEncryptionWorkspaceExecutionConfigMigrationCandidate } from './buildAccountEncryptionWorkspaceExecutionConfigDirective';

/** The transition consumes the complete Home census, including unavailable-row failures. */
export async function fetchAccountEncryptionWorkspaceExecutionConfigMigrationCandidates(params: Readonly<{
  credentials: AuthCredentials; mode: 'plain' | 'e2ee';
  request(path: string, init?: RequestInit): Promise<Response>;
}>): Promise<readonly AccountEncryptionWorkspaceExecutionConfigMigrationCandidate[]> {
  const material = params.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
  const { rows } = await createWorkspaceExecutionConfigApiV1({ request: params.request }).list();
  return rows.flatMap((row) => row.content === null ? [] : [{
    rowId: row.rowId, revision: row.revision,
    value: openWorkspaceExecutionConfigContentV1({ rowId: row.rowId, mode: params.mode, material, content: row.content }),
  }]);
}
