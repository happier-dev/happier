import type { StoredCredentials } from '@/persistence';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { AdmittedRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import type { SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

type PendingInactiveSessionActivationResult =
  | Readonly<{ status: 'activated' }>
  | Readonly<{
      status: 'not-needed';
      reason:
        | 'pending-resolved'
        | 'authorization-stale'
        | 'target-mismatch'
        | 'snapshot-stale'
        | 'spawn-ambiguous';
    }>
  | Readonly<{
      status: 'rejected';
      reason:
        | 'ineligible'
        | 'identity-unavailable'
        | 'takeover-required'
        | 'session-directory-missing'
        | 'spawn-rejected';
    }>;

type PendingInactiveSessionActivationParams = Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  spawnSession: (options: NonNullable<ReturnType<typeof buildInactiveSessionResumeSpawnOptions>>) => Promise<SpawnSessionResult>;
  /** Supplied only by the canonical requester runtime resolver, never a pending hint. */
  requester?: Pick<AdmittedRequesterSessionBootstrap, 'attribution' | 'serverHttpBaseUrl' | 'isCurrent'>;
  expectedTarget?: SessionInputMachineTargetV1;
  resolveCurrentMachineExecutionOriginContext?: () => Promise<CurrentMachineExecutionOriginContext | null>;
}>;

export async function activatePendingInactiveSession(params: PendingInactiveSessionActivationParams): Promise<PendingInactiveSessionActivationResult> {
  return params.requester
    ? await runWithServerHttpBaseUrl(params.requester.serverHttpBaseUrl, () => activateAtAdmittedHome(params))
    : await activateAtAdmittedHome(params);
}

async function activateAtAdmittedHome(params: PendingInactiveSessionActivationParams): Promise<PendingInactiveSessionActivationResult> {
  const matchesTarget = (actual: SessionInputMachineTargetV1 | undefined) => !params.expectedTarget || actual !== undefined
    && actual.homeId === params.expectedTarget.homeId && actual.accountId === params.expectedTarget.accountId
    && actual.sessionId === params.expectedTarget.sessionId && actual.machineId === params.expectedTarget.machineId
    && actual.installationId === params.expectedTarget.installationId;
  const isCurrent = async () => {
    try {
      if (params.expectedTarget) {
        const origin = await params.resolveCurrentMachineExecutionOriginContext?.();
        if (origin?.serverIdentityId !== params.expectedTarget.homeId || origin.machineId !== params.expectedTarget.machineId) return false;
      }
      return params.requester ? await params.requester.isCurrent() : true;
    }
    catch { return false; }
  };
  if (params.requester && params.requester.attribution.machineId !== params.machineId) {
    return { status: 'not-needed', reason: 'target-mismatch' };
  }
  if (!await isCurrent()) return { status: 'not-needed', reason: 'authorization-stale' };
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
    reason: 'manual-recovery',
  });
  if (!rawSession || rawSession.id !== params.sessionId || !await isCurrent()
    || params.requester && readSessionAccessProjectionRoleV1(rawSession) !== 'owner') {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  const authorization = rawSession.pendingActivationAuthorization;
  if (
    !authorization
    || authorization.requestId !== params.requestId
    || authorization.status !== 'waiting'
    || !matchesTarget(authorization.admittedTarget)
  ) {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  // `active` is a relay projection, not runner liveness. After a daemon restart it can remain
  // true while this machine tracks no consumer. The spawn owner below is the single authority:
  // it adopts a serviceable runner and spawns only after proving one absent.
  const rejectTerminal = async (
    reason: Extract<PendingInactiveSessionActivationResult, { status: 'rejected' }>['reason'],
  ): Promise<PendingInactiveSessionActivationResult> => {
    if (!await isCurrent()) return { status: 'not-needed', reason: 'authorization-stale' };
    const report = await reportPendingSessionActivationFailure({
      token: params.credentials.token,
      sessionId: params.sessionId,
      requestId: params.requestId,
      requestedAt: authorization.requestedAt,
      failureCode: 'runtime_start_failed',
    });
    return report.didFail
      ? { status: 'rejected', reason }
      : { status: 'not-needed', reason: 'authorization-stale' };
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
  if (!await isCurrent()) return { status: 'not-needed', reason: 'authorization-stale' };
  if (pendingEligibility === 'missing') {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }
  if (pendingEligibility === 'ineligible') return await rejectTerminal('ineligible');

  const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({
    token: params.credentials.token,
  });
  if (!await isCurrent()) return { status: 'not-needed', reason: 'authorization-stale' };

  // Linearize against Pending mutation transactions without introducing a
  // second claim owner: read the exact row first, then the Session authorization
  // and state last. Everything after this point until spawn is daemon-local.
  const finalPendingEligibility = await readPendingQueueV2ActivationEligibilityFromServer({
    token: params.credentials.token,
    sessionId: params.sessionId,
    requestId: params.requestId,
  });
  if (finalPendingEligibility !== 'eligible') {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }
  const finalRawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
    reason: 'manual-recovery',
  });
  const finalAuthorization = finalRawSession?.pendingActivationAuthorization;
  if (
    !finalRawSession
    || finalRawSession.id !== params.sessionId
    || !finalAuthorization
    || finalAuthorization.requestId !== params.requestId
    || finalAuthorization.requestedAt !== authorization.requestedAt
    || finalAuthorization.status !== 'waiting'
    || !matchesTarget(finalAuthorization.admittedTarget)
    || !await isCurrent()
    || params.requester && readSessionAccessProjectionRoleV1(finalRawSession) !== 'owner'
  ) {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  if (finalRawSession.archivedAt !== null && finalRawSession.archivedAt !== undefined) {
    return { status: 'not-needed', reason: 'authorization-stale' };
  }
  if ((finalRawSession.pendingCount ?? 0) < 1) {
    return { status: 'not-needed', reason: 'pending-resolved' };
  }

  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession: finalRawSession,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
  });
  if (!metadata) {
    return await rejectTerminal('identity-unavailable');
  }
  // Pending delivery must not spawn a hosted runtime for a Session whose
  // transcript lives with an external Agent — External Sessions takeover owns
  // that activation. An unresolved link fails closed the same way.
  const linkAuthority = resolveLinkedExternalSessionAuthorityV1(metadata);
  if (!linkAuthority.ok) {
    return await rejectTerminal('takeover-required');
  }
  if (linkAuthority.transcriptStorage === 'direct') {
    return await rejectTerminal('takeover-required');
  }
  const options = buildInactiveSessionResumeSpawnOptions({
    sessionId: params.sessionId,
    rawSession: finalRawSession,
    metadata,
    initialTranscriptAfterSeq: finalRawSession.seq,
    executionAuthorization: {
      provenance: 'user_request',
      requestId: params.requestId,
      requestedAt: authorization.requestedAt,
    },
  });
  if (!options) {
    return await rejectTerminal('identity-unavailable');
  }
  if (options.machineId !== params.machineId) {
    return { status: 'not-needed', reason: 'target-mismatch' };
  }

  if (!await isCurrent()) return { status: 'not-needed', reason: 'authorization-stale' };
  const result = await params.spawnSession(params.requester ? { ...options,
    requesterWorkAttributionV1: params.requester.attribution,
    verifyRequesterMachineAdmissionCurrent: isCurrent,
  } : options);
  if (
    (result.type === 'error' && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT)
    || (result.type === 'success' && result.sessionId !== params.sessionId)
  ) {
    return { status: 'not-needed', reason: 'spawn-ambiguous' };
  }
  if (result.type === 'error' && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING) {
    return await rejectTerminal('session-directory-missing');
  }
  if (result.type !== 'success') return await rejectTerminal('spawn-rejected');
  return { status: 'activated' };
}
