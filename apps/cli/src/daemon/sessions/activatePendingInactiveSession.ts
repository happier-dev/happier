import type { Credentials } from '@/persistence';
import { listPendingQueueV2LocalIdsFromServer } from '@/api/session/pendingQueueV2Transport';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

type PendingInactiveSessionActivationResult =
  | Readonly<{ status: 'activated' }>
  | Readonly<{
      status: 'not-needed';
      reason: 'active' | 'pending-resolved';
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'session-unavailable' | 'snapshot-stale' | 'identity-unavailable' | 'spawn-rejected';
    }>;

export async function activatePendingInactiveSession(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  spawnSession: (options: NonNullable<ReturnType<typeof buildInactiveSessionResumeSpawnOptions>>) => Promise<SpawnSessionResult>;
}>): Promise<PendingInactiveSessionActivationResult> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
    reason: 'manual-recovery',
  });
  if (!rawSession || rawSession.id !== params.sessionId) {
    return { status: 'rejected', reason: 'session-unavailable' };
  }
  if (rawSession.active === true) {
    return { status: 'not-needed', reason: 'active' };
  }
  if (
    typeof rawSession.pendingVersion === 'number'
    && rawSession.pendingVersion < params.pendingVersion
  ) {
    return { status: 'rejected', reason: 'snapshot-stale' };
  }
  if ((rawSession.pendingCount ?? 0) < 1) {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }

  const pendingLocalIds = await listPendingQueueV2LocalIdsFromServer({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!pendingLocalIds.includes(params.requestId)) {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }

  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession,
  });
  if (!metadata) {
    return { status: 'rejected', reason: 'identity-unavailable' };
  }
  const options = buildInactiveSessionResumeSpawnOptions({
    sessionId: params.sessionId,
    rawSession,
    metadata,
    initialTranscriptAfterSeq: rawSession.seq,
    executionAuthorization: {
      provenance: 'user_request',
      requestId: params.requestId,
    },
  });
  if (!options || options.machineId !== params.machineId) {
    return { status: 'rejected', reason: 'identity-unavailable' };
  }

  const result = await params.spawnSession(options);
  if (
    result.type !== 'success'
    || (typeof result.sessionId === 'string' && result.sessionId !== params.sessionId)
  ) {
    return { status: 'rejected', reason: 'spawn-rejected' };
  }
  return { status: 'activated' };
}
