import type { AgentId } from '@happier-dev/agents';
import type { SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type SessionUsageLimitRecoveryControlAdapterParams = Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  currentMachineId: string | null;
  sessionMachineId: string | null;
  cwd: string | null;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  ctx: SessionEncryptionContext;
  mode: SessionStoredContentEncryptionMode;
}>;

export type SessionUsageLimitRecoveryControlAdapter = Readonly<{
  checkNow?: (params: SessionUsageLimitRecoveryControlAdapterParams) => Promise<unknown>;
}>;

export type ResolveSessionUsageLimitRecoveryControlAdapter = (
  agentId?: AgentId | null,
) => Promise<SessionUsageLimitRecoveryControlAdapter | null>;
