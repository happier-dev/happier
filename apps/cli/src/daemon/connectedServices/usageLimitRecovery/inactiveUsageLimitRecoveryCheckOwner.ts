import type { AccountEncryptionCurrentnessResponse, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { StoredCredentials } from '@/persistence';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { usageLimitRecoveryDisabledResult } from '@/features/usageLimitRecoveryFeatureGate';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import { readSessionOwnerLocality, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import { hasSameUsageLimitRecoveryIdentity, isPendingUsageLimitRecoveryStatus } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';

import {
  type UsageLimitRecoveryCancelExactResult,
  UsageLimitRecoveryScheduler,
} from './UsageLimitRecoveryScheduler';

type RestoreSessionCommonInput = Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  currentMachineHost: string;
  currentMachineHomeDir: string;
  scheduler: UsageLimitRecoveryScheduler;
  getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot | undefined;
  isCurrent: () => boolean;
  runCheckNow: (sessionId: string) => Promise<unknown>;
}>;

type RestoreSessionInput = RestoreSessionCommonInput & Readonly<{ sessionId: string }>;
type RestoreSessionsInput = RestoreSessionCommonInput & Readonly<{ sessions: readonly RawSessionListRow[] }>;

function recoveryEnabled(input: RestoreSessionCommonInput): boolean {
  const serverSnapshot = input.getServerFeaturesSnapshot();
  return input.isCurrent() && resolveCliFeatureDecision({ featureId: 'sessions.usageLimitRecovery',
    env: process.env, ...(serverSnapshot ? { serverSnapshot } : {}),
  }).state === 'enabled';
}

async function readRestorableSessionRecord(
  input: RestoreSessionInput,
  rawSession: RawSessionListRow,
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse,
): Promise<
  | Readonly<{ status: 'ready'; recovery: SessionUsageLimitRecoveryV1; active: boolean; interrupted: boolean }>
  | Readonly<{ status: 'disabled' | 'stale' | 'unavailable' }>
> {
  if (!recoveryEnabled(input) || !input.isCurrent()) return { status: 'disabled' };
  if (rawSession.id !== input.sessionId
    || readSessionAccessProjectionRoleV1(rawSession) !== 'owner' || rawSession.archivedAt != null
    || rawSession.latestTurnStatus === 'completed' || rawSession.latestTurnStatus === 'cancelled') return { status: 'stale' };
  const metadata = tryDecryptSessionOwnerMetadataView({ credentials: input.credentials, rawSession,
    accountEncryptionMode: accountEncryptionCurrentness.mode });
  if (!metadata) return { status: 'unavailable' };
  const recovery = createStoredReadSchema(SessionUsageLimitRecoveryV1Schema).safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  if (!recovery.success || !isPendingUsageLimitRecoveryStatus(recovery.data.status)
    || recovery.data.runtimeAuthRecoveryAttemptId) return { status: 'stale' };
  const locality = readSessionOwnerLocality({ metadata, rawSession });
  if (!locality || !await resolveMachineControlLocalityProof({ credentials: input.credentials,
    sessionMachineId: locality.machineId, sessionHost: locality.host, sessionHomeDir: locality.homeDir,
    currentMachineId: input.machineId, currentMachineHost: input.currentMachineHost,
    currentMachineHomeDir: input.currentMachineHomeDir,
  })) return { status: 'stale' };
  const linkAuthority = resolveLinkedExternalSessionAuthorityV1(metadata);
  if (!linkAuthority.ok || linkAuthority.transcriptStorage === 'direct') return { status: 'stale' };
  if (!input.isCurrent()) return { status: 'stale' };
  return { status: 'ready', recovery: recovery.data, active: rawSession.active === true,
    interrupted: rawSession.latestTurnStatus == null || rawSession.latestTurnStatus === 'failed' };
}

async function readRestorableSession(input: RestoreSessionInput): Promise<
  | Readonly<{ status: 'ready'; recovery: SessionUsageLimitRecoveryV1; active: boolean; interrupted: boolean }>
  | Readonly<{ status: 'disabled' | 'stale' | 'unavailable' }>
> {
  if (!recoveryEnabled(input)) return { status: 'disabled' };
  const serverFeaturesSnapshot = input.getServerFeaturesSnapshot();
  const target = await resolveSessionTransportContext({ reason: 'session-control', credentials: input.credentials, idOrPrefix: input.sessionId,
    ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
  });
  if (!input.isCurrent()) return { status: 'stale' };
  if (!target.ok) return { status: target.code === 'session_not_found' ? 'stale' : 'unavailable' };
  if (target.sessionId !== input.sessionId) return { status: 'stale' };
  return await readRestorableSessionRecord(input, target.rawSession, target.accountEncryptionCurrentness);
}

export function createInactiveUsageLimitRecoveryCheckOwner() {
  let nextMutationSequence = 0;
  const runnersBySessionId = new Map<string, Readonly<{
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
    runCheckNow: () => Promise<unknown>;
    mutationSequence: number;
  }>>();

  const schedule = async (input: Readonly<{
    sessionId: string;
    recovery: SessionUsageLimitRecoveryV1;
    runCheckNow: () => Promise<unknown>;
    scheduler: UsageLimitRecoveryScheduler;
  }>): Promise<void> => {
    const mutationSequence = ++nextMutationSequence;
    const runner = {
      issueFingerprint: input.recovery.issueFingerprint,
      armedAtMs: input.recovery.armedAtMs,
      ...(input.recovery.runtimeAuthRecoveryAttemptId
        ? { runtimeAuthRecoveryAttemptId: input.recovery.runtimeAuthRecoveryAttemptId }
        : {}),
      runCheckNow: input.runCheckNow,
      mutationSequence,
    };
    const committed = await input.scheduler.upsertScheduled({
      sessionId: input.sessionId,
      intent: input.recovery,
    });
    const fresh = input.scheduler.read(input.sessionId);
    if (
      !hasSameUsageLimitRecoveryIdentity(committed, input.recovery)
      || !fresh
      || !hasSameUsageLimitRecoveryIdentity(fresh, committed)
      || fresh.status !== committed.status
      || fresh.attemptCount !== committed.attemptCount
      || fresh.nextCheckAtMs !== committed.nextCheckAtMs
    ) return;
    const currentRunner = runnersBySessionId.get(input.sessionId);
    if (!currentRunner || currentRunner.mutationSequence <= mutationSequence) {
      runnersBySessionId.set(input.sessionId, runner);
    }
  };

  const restoreReadySession = async (input: RestoreSessionInput, initial: Extract<Awaited<ReturnType<typeof readRestorableSession>>, { status: 'ready' }>): Promise<void> => {
    if (initial.active || !initial.interrupted) return;
    const expected = initial.recovery;
    const existing = runnersBySessionId.get(input.sessionId);
    if (existing && hasSameUsageLimitRecoveryIdentity(existing, expected)) return;
    await schedule({ sessionId: input.sessionId, recovery: expected, scheduler: input.scheduler,
      runCheckNow: async () => {
        const current = await readRestorableSession(input);
        if (current.status === 'disabled') return usageLimitRecoveryDisabledResult();
        if (current.status === 'unavailable') return { ok: false, status: 'unavailable', errorCode: 'usage_limit_recovery_context_unavailable' };
        const scheduled = input.scheduler.read(input.sessionId);
        if (current.status !== 'ready' || !hasSameUsageLimitRecoveryIdentity(current.recovery, expected)
          || !scheduled || !isPendingUsageLimitRecoveryStatus(scheduled.status)
          || !hasSameUsageLimitRecoveryIdentity(scheduled, expected)) {
          return { ok: false, status: 'cancelled', errorCode: 'usage_limit_recovery_attempt_superseded' };
        }
        if (!recoveryEnabled(input)) return usageLimitRecoveryDisabledResult();
        // Active adoption delegates to the registered live owner after exact
        // identity proof; only initial discovery is restricted to inactive Sessions.
        return await input.runCheckNow(input.sessionId);
      },
    });
  };

  const owner = {
    hasRunner: (sessionId: string): boolean => runnersBySessionId.has(sessionId),
    run: async (sessionId: string): Promise<unknown | null> => {
      const runner = runnersBySessionId.get(sessionId);
      return runner ? await runner.runCheckNow() : null;
    },
    schedule,
    /** Reconnect uses its canonical owner-only inventory and one Account witness. */
    restoreSessions: async (input: RestoreSessionsInput): Promise<void> => {
      if (!recoveryEnabled(input) || input.sessions.length === 0) return;
      const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({ token: input.credentials.token });
      if (!input.isCurrent()) return;
      for (const rawSession of input.sessions) {
        if (!input.isCurrent()) return;
        const sessionInput = { ...input, sessionId: rawSession.id };
        const initial = await readRestorableSessionRecord(sessionInput, rawSession, accountEncryptionCurrentness);
        if (initial.status === 'ready') await restoreReadySession(sessionInput, initial);
      }
    },
    cancelSession: async (input: Readonly<{
      sessionId: string;
      scheduler: UsageLimitRecoveryScheduler;
    }>): Promise<SessionUsageLimitRecoveryV1 | null> => {
      const cancelled = await input.scheduler.cancel({ sessionId: input.sessionId });
      runnersBySessionId.delete(input.sessionId);
      return cancelled;
    },
    cancelExact: async (input: Readonly<{
      sessionId: string;
      issueFingerprint: string;
      armedAtMs: number;
      runtimeAuthRecoveryAttemptId?: string;
      scheduler: UsageLimitRecoveryScheduler;
    }>): Promise<UsageLimitRecoveryCancelExactResult> => {
      const result = await input.scheduler.cancelExact(input);
      if (result.status !== 'cancelled') return result;
      const runner = runnersBySessionId.get(input.sessionId);
      if (runner && hasSameUsageLimitRecoveryIdentity(runner, input)) {
        runnersBySessionId.delete(input.sessionId);
      }
      return result;
    },
  };
  return owner;
}
