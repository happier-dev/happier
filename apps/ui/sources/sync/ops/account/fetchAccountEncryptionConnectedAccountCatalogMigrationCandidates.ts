import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
  openConnectedAccountCatalogContentV1, type ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { AccountEncryptionConnectedAccountCatalogMigrationCandidates } from './buildAccountEncryptionConnectedAccountCatalogDirectives';

/** Read both actual captured Home rows; display projections cannot authorize conversion. */
export async function fetchAccountEncryptionConnectedAccountCatalogMigrationCandidates(params: Readonly<{
  credentials: AuthCredentials; mode: 'plain' | 'e2ee'; request(path: string, init?: RequestInit): Promise<Response>;
  assertCurrent?: () => void;
}>): Promise<AccountEncryptionConnectedAccountCatalogMigrationCandidates> {
  params.assertCurrent?.();
  const material = params.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
  const read = async (key: ConnectedAccountCatalogKeyV1) => {
    const response = await params.request(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/${key}`, { method: 'GET' });
    params.assertCurrent?.();
    if (!response.ok) throw new Error('Connected catalog migration census is unavailable');
    const row = ConnectedAccountCatalogRowReadResponseV1Schema.parse(await response.json());
    params.assertCurrent?.();
    if (row.status === 'absent') return undefined;
    if (row.status === 'deleted') return { revision: row.revision, migrationSource: null };
    if (row.status !== 'present') throw new Error(row.status);
    const opened = openConnectedAccountCatalogContentV1({ key, mode: params.mode, material, content: row.content, admission: 'migration' });
    if (opened.status !== 'opened') throw new Error(opened.status === 'partial'
      ? 'Connected catalog migration census is incomplete' : opened.reason);
    return { revision: row.revision, migrationSource: opened.migrationSource };
  };
  const [connectedConfigurations, connectedPurposes] = await Promise.all([read('configurations'), read('purposes')]);
  params.assertCurrent?.();
  return { ...(connectedConfigurations ? { connectedConfigurations } : {}),
    ...(connectedPurposes ? { connectedPurposes } : {}) };
}
