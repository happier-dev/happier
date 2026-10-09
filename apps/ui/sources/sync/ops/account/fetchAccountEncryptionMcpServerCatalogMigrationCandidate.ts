import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchMcpServerCatalogRowV1 } from '@/sync/api/account/apiMcpServerCatalog';
import { openMcpServerCatalogContentV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { AccountEncryptionMcpServerCatalogMigrationCandidate } from './buildAccountEncryptionMcpServerCatalogDirective';

/** Conversion opens the actual complete row, never a cached partial display projection. */
export async function fetchAccountEncryptionMcpServerCatalogMigrationCandidate(input: Readonly<{
  credentials: AuthCredentials; mode: 'plain' | 'e2ee';
  request(path: string, init?: RequestInit): Promise<Response>; assertCurrent?: () => void;
}>): Promise<AccountEncryptionMcpServerCatalogMigrationCandidate | undefined> {
  const row = await fetchMcpServerCatalogRowV1(input);
  if (row.status === 'absent') return undefined;
  if (row.status === 'deleted') return { revision: row.revision, catalog: null };
  if (row.status !== 'present') throw new Error('MCP catalog migration inventory is unavailable');
  const opened = openMcpServerCatalogContentV1({ mode: input.mode, content: row.content, admission: 'migration',
    material: input.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(input.credentials) });
  if (opened.status !== 'opened') throw new Error('MCP catalog migration inventory is incomplete or unavailable');
  return { revision: row.revision, catalog: opened.catalog, migrationSource: opened.migrationSource };
}
