import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { readAcpCatalogRow } from '@/sync/api/account/apiAcpCatalog';
import type { ServerFetch } from '@/sync/http/client';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AccountEncryptionAcpCatalogMigrationCandidate } from './buildAccountEncryptionAcpCatalogDirective';

/** Census does not initialize or transfer source Settings during an Account conversion. */
export async function fetchAccountEncryptionAcpCatalogMigrationCandidate(params: Readonly<{
  credentials: AuthCredentials; mode: 'plain' | 'e2ee'; request: ServerFetch; assertCurrent(): void;
}>): Promise<AccountEncryptionAcpCatalogMigrationCandidate | undefined> {
  const material = params.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
  const row = await readAcpCatalogRow(params);
  if (row.status === 'absent') return undefined;
  if (row.status === 'deleted') return { revision: row.revision, record: null };
  if (row.status !== 'present') throw new Error('ACP catalog migration census is unavailable');
  const opened = openAcpCatalogContentV1({ mode: params.mode, material, content: row.content, admission: 'migration' });
  if (opened.status !== 'opened') throw new Error('ACP catalog migration census is incomplete or unavailable');
  return { revision: row.revision, record: opened.record, migrationSource: opened.migrationSource };
}
