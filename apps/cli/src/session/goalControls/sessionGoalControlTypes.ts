import type { SessionGoalSetRequestV1 } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type SessionGoalControlOperation = 'get' | 'set' | 'clear';

export type SessionGoalControlAdapterParams = Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  currentMachineId: string | null;
  sessionMachineId: string | null;
  cwd: string | null;
}> & SessionStoredContentCryptoContext;

export type SessionGoalControlAdapter = Readonly<{
  getGoal?: (params: SessionGoalControlAdapterParams) => Promise<unknown>;
  setGoal?: (params: SessionGoalControlAdapterParams & Readonly<{
    request: SessionGoalSetRequestV1;
  }>) => Promise<unknown>;
  clearGoal?: (params: SessionGoalControlAdapterParams) => Promise<unknown>;
}>;

export type ResolveSessionGoalControlAdapter = (
  agentId?: CatalogAgentId | null,
) => Promise<SessionGoalControlAdapter | null>;
