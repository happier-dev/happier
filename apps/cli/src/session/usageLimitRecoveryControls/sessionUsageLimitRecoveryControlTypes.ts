import type { SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type SessionUsageLimitRecoveryControlAdapterParams = Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  currentMachineId: string | null;
  sessionMachineId: string | null;
  cwd: string | null;
  issueFingerprint?: string;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
}> & SessionStoredContentCryptoContext;

export type SessionUsageLimitRecoveryControlAdapter = Readonly<{
  checkNow?: (params: SessionUsageLimitRecoveryControlAdapterParams) => Promise<unknown>;
  consumeResetCredit?: (params: SessionUsageLimitRecoveryControlAdapterParams) => Promise<unknown>;
}>;

export type SessionUsageLimitRecoveryBackoffPolicy = Readonly<{
  providerId: string;
  issueProviderFilter?: string | null;
  defaultNativeServiceId?: import('@happier-dev/protocol').ConnectedServiceId | null;
  fallbackBackoffEnvKey: string;
  maxAttemptsEnvKey: string;
  defaultFallbackBackoffMs: number;
  defaultMaxAttempts: number;
}>;

export type SessionUsageLimitRecoveryReadinessProbeResult =
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'waiting'; retryAfterMs?: number }>
  | Readonly<{ status: 'unavailable'; errorCode: string }>;

export type ResolveSessionUsageLimitRecoveryControlAdapter = (
  agentId?: CatalogAgentId | null,
) => Promise<SessionUsageLimitRecoveryControlAdapter | null>;
