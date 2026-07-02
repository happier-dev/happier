import type { AgentId } from '@happier-dev/agents';
import type { SessionGoalSetRequestV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type SessionGoalControlOperation = 'get' | 'set' | 'clear';

export type SessionGoalControlAdapterParams = Readonly<{
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

export type SessionGoalControlAdapter = Readonly<{
  getGoal?: (params: SessionGoalControlAdapterParams) => Promise<unknown>;
  setGoal?: (params: SessionGoalControlAdapterParams & Readonly<{
    request: SessionGoalSetRequestV1;
  }>) => Promise<unknown>;
  clearGoal?: (params: SessionGoalControlAdapterParams) => Promise<unknown>;
}>;

export type ResolveSessionGoalControlAdapter = (
  agentId?: AgentId | null,
) => Promise<SessionGoalControlAdapter | null>;
