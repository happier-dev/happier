import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { Credentials } from '@/persistence';
import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';

type PendingSessionRuntimeActivationResult =
  | Readonly<{
      status: 'activated';
      runnerAcceptance?: Extract<SpawnSessionResult, { type: 'success' }>['runnerAcceptance'];
    }>
  | Readonly<{
      status: 'not-needed';
      reason: 'pending-resolved' | 'authorization-stale' | 'target-mismatch' | 'snapshot-stale' | 'spawn-ambiguous';
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'ineligible' | 'identity-unavailable' | 'spawn-rejected';
    }>;

export async function activatePendingSessionRuntime(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  spawnSession: (options: NonNullable<ReturnType<typeof buildInactiveSessionResumeSpawnOptions>>) => Promise<SpawnSessionResult>;
}>): Promise<PendingSessionRuntimeActivationResult> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
    reason: 'manual-recovery',
  });
  if (!rawSession || rawSession.id !== params.sessionId) {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  const authorization = rawSession.pendingActivationAuthorization;
  if (
    !authorization
    || authorization.requestId !== params.requestId
    || authorization.status !== 'waiting'
  ) {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  // `active` is a relay projection, not runner liveness. After a daemon restart it can remain
  // true while this machine tracks no consumer. The spawn owner below is the single authority:
  // it adopts a serviceable runner and spawns only after proving one absent.
  const rejectTerminal = async (
    reason: Extract<PendingSessionRuntimeActivationResult, { status: 'rejected' }>['reason'],
  ): Promise<PendingSessionRuntimeActivationResult> => {
    const report = await reportPendingSessionActivationFailure({
      token: params.credentials.token,
      sessionId: params.sessionId,
      requestId: params.requestId,
      requestedAt: authorization.requestedAt,
      failureCode: 'runtime_start_failed',
    });
    if (!report.didFail) {
      return { status: 'not-needed', reason: 'authorization-stale' };
    }
    return { status: 'rejected', reason };
  };
  if (rawSession.archivedAt !== null && rawSession.archivedAt !== undefined) {
    return await rejectTerminal('ineligible');
  }
  if (
    typeof rawSession.pendingVersion === 'number'
    && rawSession.pendingVersion < params.pendingVersion
  ) {
    return { status: 'not-needed', reason: 'snapshot-stale' };
  }
  if ((rawSession.pendingCount ?? 0) < 1) {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }

  const pendingEligibility = await readPendingQueueV2ActivationEligibilityFromServer({
    token: params.credentials.token,
    sessionId: params.sessionId,
    requestId: params.requestId,
  });
  if (pendingEligibility === 'missing') {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }
  if (pendingEligibility === 'ineligible') return await rejectTerminal('ineligible');

  const currentPendingEligibility = await readPendingQueueV2ActivationEligibilityFromServer({
    token: params.credentials.token,
    sessionId: params.sessionId,
    requestId: params.requestId,
  });
  if (currentPendingEligibility === 'missing') {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }
  if (currentPendingEligibility === 'ineligible') {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }

  const currentSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
    reason: 'manual-recovery',
  });
  const currentAuthorization = currentSession?.pendingActivationAuthorization;
  if (
    !currentSession
    || currentSession.id !== params.sessionId
    || !currentAuthorization
    || currentAuthorization.requestId !== params.requestId
    || currentAuthorization.requestedAt !== authorization.requestedAt
    || currentAuthorization.status !== 'waiting'
  ) {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  if (currentSession.archivedAt !== null && currentSession.archivedAt !== undefined) {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  if (
    typeof currentSession.pendingVersion === 'number'
    && currentSession.pendingVersion < Math.max(params.pendingVersion, rawSession.pendingVersion ?? 0)
  ) {
    return { status: 'not-needed', reason: 'snapshot-stale' };
  }
  if ((currentSession.pendingCount ?? 0) < 1) {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }

  const metadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: currentSession,
  });
  if (!metadata) {
    return await rejectTerminal('identity-unavailable');
  }
  const options = buildInactiveSessionResumeSpawnOptions({
    sessionId: params.sessionId,
    rawSession: currentSession,
    metadata,
    initialTranscriptAfterSeq: currentSession.seq,
    executionAuthorization: {
      provenance: 'user_request',
      requestId: params.requestId,
      requestedAt: authorization.requestedAt,
    },
  });
  if (!options) {
    return await rejectTerminal('identity-unavailable');
  }
  if (!await resolveMachineControlLocalityProof({
    sessionMachineId: options.machineId,
    currentMachineId: params.machineId,
    credentials: params.credentials,
  })) return { status: 'not-needed', reason: 'target-mismatch' };
  // Replacement changes execution placement, never the Session's retained metadata.
  options.machineId = params.machineId;

  const result = await params.spawnSession(options);
  if (
    (result.type === 'error' && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT)
    || (result.type === 'success' && result.sessionId !== params.sessionId)
  ) {
    return { status: 'not-needed', reason: 'spawn-ambiguous' };
  }
  if (result.type !== 'success') {
    return await rejectTerminal('spawn-rejected');
  }
  return {
    status: 'activated',
    ...(result.runnerAcceptance ? { runnerAcceptance: result.runnerAcceptance } : {}),
  };
}
