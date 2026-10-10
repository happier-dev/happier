import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema,
  openProviderConnectionsContentV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { AccountEncryptionProviderConnectionsMigrationCandidate } from './buildAccountEncryptionProviderConnectionsDirective';

/** Read the actual captured Home row; cached display content cannot authorize conversion. */
export async function fetchAccountEncryptionProviderConnectionsMigrationCandidate(params: Readonly<{
  credentials: AuthCredentials; mode: 'plain' | 'e2ee'; request(path: string, init?: RequestInit): Promise<Response>;
}>): Promise<AccountEncryptionProviderConnectionsMigrationCandidate | undefined> {
  const material = params.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
  const response = await params.request(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { method: 'GET' });
  if (!response.ok) throw new Error('Provider catalog migration census is unavailable');
  const row = ProviderConnectionsRowReadResponseV1Schema.parse(await response.json());
  if (row.status === 'absent') return undefined;
  if (row.status === 'deleted') return { revision: row.revision, catalog: null };
  if (row.status !== 'present') throw new Error(row.status);
  const opened = openProviderConnectionsContentV1({ content: row.content, mode: params.mode, material, admission: 'migration' });
  if (opened.status !== 'opened') throw new Error(opened.status === 'partial' ? 'Provider catalog migration census is incomplete' : opened.reason);
  return { revision: row.revision, catalog: opened.catalog, migrationSource: opened.migrationSource };
}
