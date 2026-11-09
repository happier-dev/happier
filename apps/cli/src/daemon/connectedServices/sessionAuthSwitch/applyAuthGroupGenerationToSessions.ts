import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { readConnectedServiceAuthGenerationApplyFailure } from '../runtimeAuth/connectedServiceAuthGenerationApplyFailure';
import { hasConnectedServiceAccountApplicationProof, readConnectedServiceAccountApplicationCredentialError } from './connectedServiceAuthSwitchOutcome';
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
  isCurrent?: () => boolean;
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
  return hasConnectedServiceAccountApplicationProof({
    target: input.committedGeneration.decisionCommittedTarget, adopted: input.providerAdoptedTarget,
  });
}

async function runSharedApplicationEffect(input: Readonly<{
  orchestration: ImmutableGenerationApplyInput;
  representative: ApplyAuthGroupGenerationSessionTarget;
  applicationOwnerId: string;
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  apply: () => Promise<GenerationApplyResult>;
}>): Promise<GenerationApplyResult> {
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
      return { reconciliationDisposition: 'failed',
        errorCode: readConnectedServiceAccountApplicationCredentialError(verified) ?? 'shared_application_verification_invalid' };
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
    if (target.isCurrent?.() === false) continue;
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
      if (sibling.isCurrent?.() === false) continue;
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

async function applyImmutableGenerationToSessions(
  input: ImmutableGenerationApplyInput,
): Promise<ApplyAuthGroupGenerationToSessionsResult> {
  throwIfFanoutAborted(input.signal);
  const committedGeneration = input.committedGeneration;
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
  const applyTarget = async (target: ApplyAuthGroupGenerationSessionTarget): Promise<void> => {
    if (target.isCurrent?.() === false) return;
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
    } catch (error) {
      throwIfFanoutAborted(input.signal);
      const errorCode = readConnectedServiceAuthGenerationApplyFailure(error)?.errorCode ?? 'apply_generation_threw';
      recordNonConvergence('failed', errorCode);
      return;
    }
    throwIfFanoutAborted(input.signal);

    if (target.isCurrent?.() === false) return;
    if (result.reconciliationDisposition === 'superseded_after_apply') {
      recordNonConvergence(result.reconciliationDisposition, result.errorCode);
      return;
    }

    if (result.reconciliationDisposition === 'converged') {
      const providerAdoptedTarget = result.providerAdoptedTarget;
      if (!providerAdoptedTarget) {
        const errorCode = 'provider_adoption_proof_missing';
        recordNonConvergence('failed', errorCode);
        return;
      }
      if (!hasConnectedServiceAccountApplicationProof({
        target: committedGeneration.decisionCommittedTarget, adopted: providerAdoptedTarget,
      })) {
        const errorCode = readConnectedServiceAccountApplicationCredentialError(providerAdoptedTarget) ?? 'provider_adoption_unproven';
        recordNonConvergence('failed', errorCode);
        return;
      }
      try {
        throwIfFanoutAborted(input.signal);
        if (target.isCurrent?.() === false) return;
        const clear = await input.clearAdoptedGeneration({ sessionId: target.sessionId, providerAdoptedTarget });
        throwIfFanoutAborted(input.signal);
        if (target.isCurrent?.() === false) return;
        if (clear?.status === 'superseded') {
          const errorCode = 'provider_adoption_clear_superseded';
          resultsBySessionId[target.sessionId] = {
            reconciliationDisposition: 'superseded_after_apply',
            errorCode,
            pendingRecorded: true,
          };
          failures.push({ sessionId: target.sessionId, errorCode });
          return;
        }
      } catch (error) {
        throwIfFanoutAborted(input.signal);
        const errorCode = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
          ? error.message
          : 'provider_adoption_clear_failed';
        recordNonConvergence('failed', errorCode);
        return;
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
  };
  // Each delivery applies once per recipient. Newer truth belongs to the projection owner.
  const workerResults = await Promise.allSettled(
    input.targets.filter((target) => target.skipInitialApply !== true).map(applyTarget),
  );
  throwIfFanoutAborted(input.signal);
  const rejectedWorker = workerResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejectedWorker) throw rejectedWorker.reason;

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
