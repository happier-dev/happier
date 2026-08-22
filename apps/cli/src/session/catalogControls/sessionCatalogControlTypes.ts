import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type SessionCatalogControlOperation = 'vendorPlugins' | 'skills';

export type SessionCatalogControlAdapterParams = Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  currentMachineId: string | null;
  sessionMachineId: string | null;
  cwd: string | null;
}> & SessionStoredContentCryptoContext;

export type SessionCatalogControlAdapter = Readonly<{
  listVendorPlugins?: (params: SessionCatalogControlAdapterParams) => Promise<unknown>;
  listSkills?: (params: SessionCatalogControlAdapterParams) => Promise<unknown>;
}>;

export type ResolveSessionCatalogControlAdapter = (
  agentId?: CatalogAgentId | null,
) => Promise<SessionCatalogControlAdapter | null>;
