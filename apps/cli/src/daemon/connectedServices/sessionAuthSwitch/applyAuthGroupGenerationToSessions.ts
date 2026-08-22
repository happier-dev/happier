import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import type {
  ConnectedServiceAuthGenerationReconciliationDisposition,
  ConnectedServiceAuthGroupCommittedGenerationFact,
  ConnectedServiceGenerationExecutionAuthority,
  ConnectedServiceProviderAdoptedGenerationTarget,
} from './connectedServiceAuthSwitchOutcome';

export type ApplyAuthGroupGenerationSessionTarget = Readonly<{
  sessionId: string;
  fromProfileId: string | null;
  skipInitialApply?: boolean;
  applicationScope?: 'per_session_runtime' | 'shared_group_auth_surface';
  applicationOwnerId?: string;
}>;

export type ApplyAuthGroupGenerationToSessionsResult = Readonly<{
  ok: boolean;
  appliedSessionCount: number;
  restartRequestedSessionCount: number;
  skippedIdleSessionCount: number;
  failedSessionCount: number;
  failures: ReadonlyArray<Readonly<{ sessionId: string; errorCode: string | null }>>;
  resultsBySessionId?: Readonly<Record<string, Readonly<{
    reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
    errorCode: string | null;
    pendingRecorded: boolean;
    restartRequested?: boolean;
  }>>>;
}>;

/**
 * Sessions are independent (the switch FSM serializes per session, and the shared-home
 * materializer owns its own write locks), but each apply can legitimately wait a full
 * turn-boundary deferral window before it may restart. Bounded parallelism keeps the fan-out's
 * wall-clock at ~one deferral window instead of the sum across sessions (the sequential shape
 * guaranteed the manual-apply ack timed out on every pool with active sessions — live incident
 * 2026-07-10), while the cap prevents a large pool from thundering-herd restarting the machine.
 */
const APPLY_FANOUT_CONCURRENCY = 4;
const MAX_GENERATION_REDISTRIBUTIONS = 4;

/**
 * Fan a server-committed auth-group generation out to the live sessions bound to the group.
 * Pure orchestration over the injected per-session FSM apply: collects per-session outcomes,
 * never lets one session's failure abort the others, and reports the same counts shape the
 * settings UI reconcile flow consumes.
 */
type ImmutableGenerationApplyInput = Readonly<{
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  switchReason: ConnectedServiceSessionAuthSwitchReason;
  targets: ReadonlyArray<ApplyAuthGroupGenerationSessionTarget>;
  signal?: AbortSignal;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  applyCommittedGeneration(input: Readonly<{
    sessionId: string;
    fromProfileId: string | null;
    committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
    applicationOwnerId?: string;
    /**
     * All recipient sessions that currently share this provider-owned surface.
     * The representative performs the one provider mutation, but the runtime
     * admission owner must fence every live producer before it starts.
     */
    applicationCohortSessionIds?: readonly string[];
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
    errorCode: string | null;
    authoritativeGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact;
    providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
    restartRequested?: boolean;
  }>>;
  applySharedGenerationApplication?(input: Readonly<{
    representativeSessionId: string;
    applicationOwnerId: string;
    applicationCohortSessionIds: readonly string[];
    committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    executionAuthority: ConnectedServiceGenerationExecutionAuthority;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
    errorCode: string | null;
    authoritativeGeneration?: ConnectedServiceAuthGroupCommittedGenerationFact;
    providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
    restartRequested?: boolean;
  }>>;
  clearAdoptedGeneration(input: Readonly<{
    sessionId: string;
    providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
  }>): Promise<void | Readonly<{ status: 'cleared' | 'superseded' }>>;
  verifySharedGenerationApplication?(input: Readonly<{
    sessionId: string;
    committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    applicationOwnerId: string;
  }>): Promise<ConnectedServiceProviderAdoptedGenerationTarget | null>;
}>;

type GenerationApplyResult = Awaited<ReturnType<ImmutableGenerationApplyInput['applyCommittedGeneration']>>;

const sharedApplicationEffectsInFlight = new Map<string, Promise<GenerationApplyResult>>();

function throwIfFanoutAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function sharedApplicationEffectKey(input: Readonly<{
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  applicationOwnerId: string;
}>): string {
  const target = input.committedGeneration.decisionCommittedTarget;
  return JSON.stringify([
    target.serviceId,
    target.groupId,
    target.profileId,
    target.generation,
    target.credentialRevision,
    input.applicationOwnerId,
  ]);
}

function isExactSharedApplicationProof(input: Readonly<{
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
}>): boolean {
  const desired = input.committedGeneration.decisionCommittedTarget;
  const adopted = input.providerAdoptedTarget;
  return desired.credentialRevision !== null
    && adopted.serviceId === desired.serviceId
    && adopted.groupId === desired.groupId
    && adopted.profileId === desired.profileId
    && adopted.generation === desired.generation
    && adopted.credentialRevision === desired.credentialRevision
    && adopted.proof.status === 'verified'
    && adopted.proof.credentialRevision === desired.credentialRevision;
}

async function runSharedApplicationEffect(input: Readonly<{
  orchestration: ImmutableGenerationApplyInput;
  representative: ApplyAuthGroupGenerationSessionTarget;
  applicationOwnerId: string;
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  apply: () => Promise<GenerationApplyResult>;
}>): Promise<GenerationApplyResult> {
  const desired = input.committedGeneration.decisionCommittedTarget;
  if (desired.credentialRevision === null) {
    return { reconciliationDisposition: 'failed', errorCode: 'shared_application_epoch_revision_missing' };
  }
  const verify = input.orchestration.verifySharedGenerationApplication;
  if (!verify) {
    return { reconciliationDisposition: 'failed', errorCode: 'shared_application_verification_wiring_missing' };
  }
  const effectKey = sharedApplicationEffectKey({
    committedGeneration: input.committedGeneration,
    applicationOwnerId: input.applicationOwnerId,
  });
  const existing = sharedApplicationEffectsInFlight.get(effectKey);
  if (existing) {
    const result = await existing;
    throwIfFanoutAborted(input.orchestration.signal);
    return result;
  }

  const effect = (async (): Promise<GenerationApplyResult> => {
    throwIfFanoutAborted(input.orchestration.signal);
    let verified: ConnectedServiceProviderAdoptedGenerationTarget | null;
    try {
      verified = await verify({
        sessionId: input.representative.sessionId,
        committedGeneration: input.committedGeneration,
        applicationOwnerId: input.applicationOwnerId,
      });
    } catch {
      throwIfFanoutAborted(input.orchestration.signal);
      return { reconciliationDisposition: 'failed', errorCode: 'shared_application_verification_failed' };
    }
    throwIfFanoutAborted(input.orchestration.signal);
    if (verified && !isExactSharedApplicationProof({
      committedGeneration: input.committedGeneration,
      providerAdoptedTarget: verified,
    })) {
      return { reconciliationDisposition: 'failed', errorCode: 'shared_application_verification_invalid' };
    }

    const result = verified
      ? { reconciliationDisposition: 'converged' as const, errorCode: null, providerAdoptedTarget: verified }
      : await input.apply();
    throwIfFanoutAborted(input.orchestration.signal);
    const adopted = result.providerAdoptedTarget;
    if (result.reconciliationDisposition !== 'converged' || !adopted || !isExactSharedApplicationProof({
      committedGeneration: input.committedGeneration,
      providerAdoptedTarget: adopted,
    })) {
      return result;
    }
    throwIfFanoutAborted(input.orchestration.signal);
    return result;
  })();
  sharedApplicationEffectsInFlight.set(effectKey, effect);
  try {
    return await effect;
  } finally {
    if (sharedApplicationEffectsInFlight.get(effectKey) === effect) {
      sharedApplicationEffectsInFlight.delete(effectKey);
    }
  }
}

export async function applyConnectedServiceAuthGroupGenerationToSessions(
  input: ImmutableGenerationApplyInput,
): Promise<ApplyAuthGroupGenerationToSessionsResult> {
  throwIfFanoutAborted(input.signal);
  const sharedTargetsByOwner = new Map<string, ApplyAuthGroupGenerationSessionTarget[]>();
  const reducedTargets: ApplyAuthGroupGenerationSessionTarget[] = [];
  for (const target of input.targets) {
    if (target.applicationScope !== 'shared_group_auth_surface' || !target.applicationOwnerId) {
      reducedTargets.push(target);
      continue;
    }
    const group = sharedTargetsByOwner.get(target.applicationOwnerId);
    if (group) {
      group.push(target);
    } else {
      sharedTargetsByOwner.set(target.applicationOwnerId, [target]);
      reducedTargets.push(target);
    }
  }
  if (sharedTargetsByOwner.size === 0) {
    return await applyImmutableGenerationToSessions(input);
  }

  const sharedRepresentativeBySessionId = new Map<string, Readonly<{
    applicationOwnerId: string;
    targets: readonly ApplyAuthGroupGenerationSessionTarget[];
  }>>();
  for (const [applicationOwnerId, targets] of sharedTargetsByOwner) {
    const representative = targets[0];
    if (representative) {
      sharedRepresentativeBySessionId.set(representative.sessionId, { applicationOwnerId, targets });
    }
  }

  const adoptedByRepresentative = new Map<string, ConnectedServiceProviderAdoptedGenerationTarget>();
  const reduced = await applyImmutableGenerationToSessions({
    ...input,
    targets: reducedTargets,
    applyCommittedGeneration: async (applyInput) => {
      const shared = sharedRepresentativeBySessionId.get(applyInput.sessionId);
      if (!shared) return await input.applyCommittedGeneration(applyInput);
      const representative = shared.targets[0];
      if (!representative) {
        return { reconciliationDisposition: 'failed', errorCode: 'shared_application_representative_missing' };
      }
      return await runSharedApplicationEffect({
        orchestration: input,
        representative,
        applicationOwnerId: shared.applicationOwnerId,
        committedGeneration: applyInput.committedGeneration,
        apply: async () => input.applySharedGenerationApplication
          ? await input.applySharedGenerationApplication({
            representativeSessionId: representative.sessionId,
            applicationOwnerId: shared.applicationOwnerId,
            applicationCohortSessionIds: shared.targets.map((target) => target.sessionId),
            committedGeneration: applyInput.committedGeneration,
            switchReason: applyInput.switchReason,
            executionAuthority: applyInput.executionAuthority,
            ...(applyInput.signal ? { signal: applyInput.signal } : {}),
          })
          : {
            reconciliationDisposition: 'failed',
            errorCode: 'shared_application_apply_wiring_missing',
          },
      });
    },
    clearAdoptedGeneration: async (clearInput) => {
      throwIfFanoutAborted(input.signal);
      adoptedByRepresentative.set(clearInput.sessionId, clearInput.providerAdoptedTarget);
      const result = await input.clearAdoptedGeneration(clearInput);
      throwIfFanoutAborted(input.signal);
      return result;
    },
  });
  throwIfFanoutAborted(input.signal);
  const expandedResults = { ...(reduced.resultsBySessionId ?? {}) };
  for (const targets of sharedTargetsByOwner.values()) {
    const representative = targets[0];
    if (!representative || targets.length === 1) continue;
    throwIfFanoutAborted(input.signal);
    const representativeResult = expandedResults[representative.sessionId];
    if (!representativeResult) continue;
    for (const sibling of targets.slice(1)) {
      throwIfFanoutAborted(input.signal);
      const adopted = adoptedByRepresentative.get(representative.sessionId);
      try {
        if (adopted) {
          const clear = await input.clearAdoptedGeneration({ sessionId: sibling.sessionId, providerAdoptedTarget: adopted });
          throwIfFanoutAborted(input.signal);
          expandedResults[sibling.sessionId] = clear?.status === 'superseded'
            ? {
                reconciliationDisposition: 'superseded_after_apply',
                errorCode: 'provider_adoption_clear_superseded',
                pendingRecorded: true,
              }
            : {
                reconciliationDisposition: 'converged',
                errorCode: null,
                pendingRecorded: false,
              };
        } else {
          expandedResults[sibling.sessionId] = { ...representativeResult, pendingRecorded: false };
        }
      } catch {
        throwIfFanoutAborted(input.signal);
        expandedResults[sibling.sessionId] = {
          reconciliationDisposition: 'failed',
          errorCode: 'provider_adoption_persist_failed',
          pendingRecorded: false,
        };
      }
    }
  }
  const entries = Object.entries(expandedResults);
  const failures = entries.flatMap(([sessionId, result]) => (
    result.reconciliationDisposition === 'failed' || result.reconciliationDisposition === 'superseded_after_apply'
      ? [{ sessionId, errorCode: result.errorCode }]
      : []
  ));
  return {
    ok: failures.length === 0,
    appliedSessionCount: entries.filter(([, result]) => result.reconciliationDisposition === 'converged').length,
    restartRequestedSessionCount: entries.filter(([, result]) => (
      result.reconciliationDisposition === 'deferred_restart' && result.restartRequested === true
    )).length,
    skippedIdleSessionCount: entries.filter(([, result]) => (
      result.reconciliationDisposition === 'deferred_restart' && result.restartRequested !== true
    )).length,
    failedSessionCount: failures.length,
    failures,
    resultsBySessionId: expandedResults,
  };
}

function isNewerGenerationFact(input: Readonly<{
  current: ConnectedServiceAuthGroupCommittedGenerationFact;
  candidate: ConnectedServiceAuthGroupCommittedGenerationFact | undefined;
}>): input is Readonly<{
  current: ConnectedServiceAuthGroupCommittedGenerationFact;
  candidate: ConnectedServiceAuthGroupCommittedGenerationFact;
}> {
  if (!input.candidate) return false;
  const current = input.current.decisionCommittedTarget;
  const candidate = input.candidate.decisionCommittedTarget;
  return candidate.serviceId === current.serviceId
    && candidate.groupId === current.groupId
    && (candidate.generation > current.generation
      || (
        candidate.generation === current.generation
        && candidate.profileId === current.profileId
        && candidate.credentialRevision !== current.credentialRevision
      ));
}

async function applyImmutableGenerationToSessions(
  input: ImmutableGenerationApplyInput,
): Promise<ApplyAuthGroupGenerationToSessionsResult> {
  throwIfFanoutAborted(input.signal);
  let committedGeneration = input.committedGeneration;
  for (let redistribution = 0; redistribution < MAX_GENERATION_REDISTRIBUTIONS; redistribution += 1) {
    let appliedSessionCount = 0;
    let restartRequestedSessionCount = 0;
    let deferredPersistedSessionCount = 0;
    const failures: Array<Readonly<{ sessionId: string; errorCode: string | null }>> = [];
    const resultsBySessionId: Record<string, {
      reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
      errorCode: string | null;
      pendingRecorded: boolean;
      restartRequested?: boolean;
    }> = {};
    const supersedingGenerations: ConnectedServiceAuthGroupCommittedGenerationFact[] = [];
    const queue = redistribution === 0
      ? input.targets.filter((target) => target.skipInitialApply !== true)
      : [...input.targets];
    const runWorker = async (): Promise<void> => {
      for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        const recordNonConvergence = (
          disposition: Exclude<ConnectedServiceAuthGenerationReconciliationDisposition, 'converged'>,
          errorCode: string | null,
        ): void => {
          resultsBySessionId[target.sessionId] = {
            reconciliationDisposition: disposition,
            errorCode,
            pendingRecorded: false,
          };
          if (disposition !== 'deferred_restart') {
            failures.push({ sessionId: target.sessionId, errorCode });
          }
        };

        throwIfFanoutAborted(input.signal);

        let result: Awaited<ReturnType<ImmutableGenerationApplyInput['applyCommittedGeneration']>>;
        try {
          result = await input.applyCommittedGeneration({
            sessionId: target.sessionId,
            fromProfileId: target.fromProfileId,
            committedGeneration,
            switchReason: input.switchReason,
            executionAuthority: input.executionAuthority,
            ...(target.applicationOwnerId ? { applicationOwnerId: target.applicationOwnerId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
        } catch {
          throwIfFanoutAborted(input.signal);
          const errorCode = 'apply_generation_threw';
          recordNonConvergence('failed', errorCode);
          continue;
        }
        throwIfFanoutAborted(input.signal);

        if (result.reconciliationDisposition === 'superseded_after_apply') {
          const authoritativeGeneration = result.authoritativeGeneration;
          if (authoritativeGeneration && isNewerGenerationFact({ current: committedGeneration, candidate: authoritativeGeneration })) {
            supersedingGenerations.push(authoritativeGeneration);
            resultsBySessionId[target.sessionId] = { ...result, pendingRecorded: false };
          } else {
            const errorCode = 'superseded_authoritative_generation_missing';
            resultsBySessionId[target.sessionId] = {
              reconciliationDisposition: 'failed',
              errorCode,
              pendingRecorded: false,
            };
            failures.push({ sessionId: target.sessionId, errorCode });
          }
          continue;
        }

        if (result.reconciliationDisposition === 'converged') {
          const providerAdoptedTarget = result.providerAdoptedTarget;
          if (!providerAdoptedTarget) {
            const errorCode = 'provider_adoption_proof_missing';
            recordNonConvergence('failed', errorCode);
            continue;
          }
          const desiredCredentialRevision = committedGeneration.decisionCommittedTarget.credentialRevision;
          const proofCredentialRevision = providerAdoptedTarget.proof.credentialRevision ?? null;
          if (
            desiredCredentialRevision === null
            || providerAdoptedTarget.credentialRevision !== desiredCredentialRevision
            || proofCredentialRevision !== desiredCredentialRevision
          ) {
            const errorCode = desiredCredentialRevision === null || proofCredentialRevision === null
              ? 'credential_revision_unproven'
              : 'credential_revision_mismatch';
            recordNonConvergence('failed', errorCode);
            continue;
          }
          try {
            throwIfFanoutAborted(input.signal);
            const clear = await input.clearAdoptedGeneration({ sessionId: target.sessionId, providerAdoptedTarget });
            throwIfFanoutAborted(input.signal);
            if (clear?.status === 'superseded') {
              const errorCode = 'provider_adoption_clear_superseded';
              resultsBySessionId[target.sessionId] = {
                reconciliationDisposition: 'superseded_after_apply',
                errorCode,
                pendingRecorded: true,
              };
              failures.push({ sessionId: target.sessionId, errorCode });
              continue;
            }
          } catch (error) {
            throwIfFanoutAborted(input.signal);
            const errorCode = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
              ? error.message
              : 'provider_adoption_clear_failed';
            recordNonConvergence('failed', errorCode);
            continue;
          }
        }

        if (result.reconciliationDisposition !== 'converged') {
          recordNonConvergence(result.reconciliationDisposition, result.errorCode);
        } else {
          resultsBySessionId[target.sessionId] = { ...result, pendingRecorded: false };
        }
        if (result.reconciliationDisposition === 'converged') {
          appliedSessionCount += 1;
        } else if (result.reconciliationDisposition === 'deferred_restart') {
          if (result.restartRequested === true) {
            restartRequestedSessionCount += 1;
          } else {
            deferredPersistedSessionCount += 1;
          }
        }
      }
    };
    const workerResults = await Promise.allSettled(Array.from({
      length: Math.min(APPLY_FANOUT_CONCURRENCY, Math.max(1, input.targets.length)),
    }, runWorker));
    throwIfFanoutAborted(input.signal);
    const rejectedWorker = workerResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejectedWorker) throw rejectedWorker.reason;

    const authoritativeGeneration = supersedingGenerations.sort((left, right) => (
      right.decisionCommittedTarget.generation - left.decisionCommittedTarget.generation
    ))[0];
    if (authoritativeGeneration && redistribution + 1 < MAX_GENERATION_REDISTRIBUTIONS) {
      committedGeneration = authoritativeGeneration;
      continue;
    }
    if (authoritativeGeneration) {
      const errorCode = 'generation_redistribution_limit_reached';
      for (const target of input.targets) {
        resultsBySessionId[target.sessionId] = {
          reconciliationDisposition: 'superseded_after_apply',
          errorCode,
          pendingRecorded: false,
        };
        failures.push({ sessionId: target.sessionId, errorCode });
      }
    }
    throwIfFanoutAborted(input.signal);
    return {
      ok: failures.length === 0,
      appliedSessionCount,
      restartRequestedSessionCount,
      skippedIdleSessionCount: deferredPersistedSessionCount,
      failedSessionCount: failures.length,
      failures,
      resultsBySessionId,
    };
  }
  throw new Error('connected_service_auth_generation_redistribution_unreachable');
}
