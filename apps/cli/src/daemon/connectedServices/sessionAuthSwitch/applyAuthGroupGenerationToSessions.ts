import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
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
  isCurrent?: () => boolean;
  skipInitialApply?: boolean;
  applicationScope?: 'per_session_runtime' | 'shared_group_auth_surface';
  applicationOwnerId?: string;
}>;

function isCurrentGenerationTarget(target: ApplyAuthGroupGenerationSessionTarget): boolean {
  return target.isCurrent?.() !== false;
}

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
    providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
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
  verifySharedGenerationApplication?(input: Readonly<{
    sessionId: string;
    committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
    applicationOwnerId: string;
  }>): Promise<ConnectedServiceProviderAdoptedGenerationTarget | null>;
  settleExactRecipientApplication?(input: Readonly<{
    sessionId: string;
    providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
  }>): Promise<void>;
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
    target: input.committedGeneration.decisionCommittedTarget,
    adopted: input.providerAdoptedTarget,
  });
}

async function runSharedApplicationEffect(input: Readonly<{
  orchestration: ImmutableGenerationApplyInput;
  representative: ApplyAuthGroupGenerationSessionTarget;
  applicationOwnerId: string;
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  apply: () => Promise<GenerationApplyResult>;
}>): Promise<GenerationApplyResult> {
  if (!isCurrentGenerationTarget(input.representative)) {
    return { reconciliationDisposition: 'failed', errorCode: 'runtime_target_registration_superseded' };
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
    if (!isCurrentGenerationTarget(input.representative)) {
      return { reconciliationDisposition: 'failed', errorCode: 'runtime_target_registration_superseded' };
    }
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
    if (!isCurrentGenerationTarget(input.representative)) {
      return { reconciliationDisposition: 'failed', errorCode: 'runtime_target_registration_superseded' };
    }
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
    if (!isCurrentGenerationTarget(input.representative)) {
      return { reconciliationDisposition: 'failed', errorCode: 'runtime_target_registration_superseded' };
    }
    const adopted = result.providerAdoptedTarget;
    if (result.reconciliationDisposition !== 'converged' || !adopted || !isExactSharedApplicationProof({
      committedGeneration: input.committedGeneration,
      providerAdoptedTarget: adopted,
    })) {
      return result;
    }
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
    if (!isCurrentGenerationTarget(target)) continue;
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
    const result = await applyImmutableGenerationToSessions(input);
    return await settleExactRecipientApplications(input, result);
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
      if (!isCurrentGenerationTarget(sibling)) continue;
      expandedResults[sibling.sessionId] = { ...representativeResult };
    }
  }
  return await settleExactRecipientApplications(input, {
    ...reduced,
    resultsBySessionId: expandedResults,
  });
}

async function settleExactRecipientApplications(
  input: ImmutableGenerationApplyInput,
  result: ApplyAuthGroupGenerationToSessionsResult,
): Promise<ApplyAuthGroupGenerationToSessionsResult> {
  const expandedResults = { ...(result.resultsBySessionId ?? {}) };
  if (input.settleExactRecipientApplication) {
    for (const target of input.targets) {
      throwIfFanoutAborted(input.signal);
      if (!isCurrentGenerationTarget(target)) continue;
      const recipient = expandedResults[target.sessionId];
      const providerAdoptedTarget = recipient?.providerAdoptedTarget;
      if (recipient?.reconciliationDisposition !== 'converged' || !providerAdoptedTarget) continue;
      try {
        await input.settleExactRecipientApplication({
          sessionId: target.sessionId,
          providerAdoptedTarget,
        });
      } catch {
        throwIfFanoutAborted(input.signal);
        expandedResults[target.sessionId] = {
          reconciliationDisposition: 'failed',
          errorCode: 'exact_recipient_settlement_failed',
        };
      }
    }
  }
  const entries = Object.entries(expandedResults);
  const failures = entries.flatMap(([sessionId, result]) => (
    result.reconciliationDisposition === 'failed'
      || result.errorCode === 'generation_redistribution_limit_reached'
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
    let deferredSessionCount = 0;
    const failures: Array<Readonly<{ sessionId: string; errorCode: string | null }>> = [];
    const resultsBySessionId: Record<string, {
      reconciliationDisposition: ConnectedServiceAuthGenerationReconciliationDisposition;
      errorCode: string | null;
      providerAdoptedTarget?: ConnectedServiceProviderAdoptedGenerationTarget;
      restartRequested?: boolean;
    }> = {};
    const supersedingGenerations: ConnectedServiceAuthGroupCommittedGenerationFact[] = [];
    const queue = (redistribution === 0
      ? input.targets.filter((target) => target.skipInitialApply !== true)
      : [...input.targets]).filter(isCurrentGenerationTarget);
    const runWorker = async (): Promise<void> => {
      for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        throwIfFanoutAborted(input.signal);
        if (!isCurrentGenerationTarget(target)) continue;

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
          resultsBySessionId[target.sessionId] = { reconciliationDisposition: 'failed', errorCode };
          failures.push({ sessionId: target.sessionId, errorCode });
          continue;
        }
        throwIfFanoutAborted(input.signal);
        if (!isCurrentGenerationTarget(target)) continue;

        if (result.reconciliationDisposition === 'superseded_after_apply') {
          const authoritativeGeneration = result.authoritativeGeneration;
          if (authoritativeGeneration && isNewerGenerationFact({ current: committedGeneration, candidate: authoritativeGeneration })) {
            supersedingGenerations.push(authoritativeGeneration);
            resultsBySessionId[target.sessionId] = { ...result };
          } else {
            const errorCode = 'superseded_authoritative_generation_missing';
            resultsBySessionId[target.sessionId] = {
              reconciliationDisposition: 'failed',
              errorCode,
            };
            failures.push({ sessionId: target.sessionId, errorCode });
          }
          continue;
        }

        if (result.reconciliationDisposition === 'converged') {
          const providerAdoptedTarget = result.providerAdoptedTarget;
          if (!providerAdoptedTarget) {
            const errorCode = 'provider_adoption_proof_missing';
            resultsBySessionId[target.sessionId] = { reconciliationDisposition: 'failed', errorCode };
            failures.push({ sessionId: target.sessionId, errorCode });
            continue;
          }
          if (!hasConnectedServiceAccountApplicationProof({
            target: committedGeneration.decisionCommittedTarget,
            adopted: providerAdoptedTarget,
          })) {
            const errorCode = readConnectedServiceAccountApplicationCredentialError(providerAdoptedTarget)
              ?? 'provider_adoption_unproven';
            resultsBySessionId[target.sessionId] = { reconciliationDisposition: 'failed', errorCode };
            failures.push({ sessionId: target.sessionId, errorCode });
            continue;
          }
          throwIfFanoutAborted(input.signal);
        }

        resultsBySessionId[target.sessionId] = { ...result };
        if (result.reconciliationDisposition === 'converged') {
          appliedSessionCount += 1;
        } else if (result.reconciliationDisposition === 'deferred_restart') {
          if (result.restartRequested === true) {
            restartRequestedSessionCount += 1;
          } else {
            deferredSessionCount += 1;
          }
        } else {
          failures.push({ sessionId: target.sessionId, errorCode: result.errorCode });
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
        };
        failures.push({ sessionId: target.sessionId, errorCode });
      }
    }
    throwIfFanoutAborted(input.signal);
    return {
      ok: failures.length === 0,
      appliedSessionCount,
      restartRequestedSessionCount,
      skippedIdleSessionCount: deferredSessionCount,
      failedSessionCount: failures.length,
      failures,
      resultsBySessionId,
    };
  }
  throw new Error('connected_service_auth_generation_redistribution_unreachable');
}
