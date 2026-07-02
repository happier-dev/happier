import type { AgentId } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type SessionCatalogControlOperation = 'vendorPlugins' | 'skills';

export type SessionCatalogControlAdapterParams = Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  currentMachineId: string | null;
  sessionMachineId: string | null;
  cwd: string | null;
  ctx: SessionEncryptionContext;
  mode: SessionStoredContentEncryptionMode;
}>;

export type SessionCatalogControlAdapter = Readonly<{
  listVendorPlugins?: (params: SessionCatalogControlAdapterParams) => Promise<unknown>;
  listSkills?: (params: SessionCatalogControlAdapterParams) => Promise<unknown>;
}>;

export type ResolveSessionCatalogControlAdapter = (
  agentId?: AgentId | null,
) => Promise<SessionCatalogControlAdapter | null>;
