import { isDeepStrictEqual } from 'node:util';
import { isModelRefGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { CallerInputConstraintsV1, ModelSelectionApplyPolicy, ProviderBoundModelRef, ProviderRuntimeBindingBasisV1, SessionModelTransitionResultV1, SessionProviderBindingMetadataV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { SessionModelMutationExpectedV1, SessionModelMutationScopeV1 } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import type { SessionModelSelectionV2 } from '@happier-dev/protocol/providers/selection/v2';
import { projectPluginFailureMessage } from '@/plugins/runtime/lifecycle/utils';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { projectSessionRuntimeFailureCause } from '@/agent/runtime/session/errors/readSessionRuntimeFailureCause';
import {
  isRuntimeConfigUpdateOutcomeApplied,
  isRuntimeConfigUpdateOutcomeDeferred,
  type RuntimeConfigUpdateOutcomeV1,
} from '@happier-dev/agents';

export type AuthorizedSessionModelTransitionTarget = Readonly<{
  selection: ProviderBoundModelRef;
  policy: ModelSelectionApplyPolicy;
  providerBinding: AgentSessionProviderBinding | null;
  sessionBindingMetadata: SessionProviderBindingMetadataV1 | null;
  runtimeBindingBasis: ProviderRuntimeBindingBasisV1 | null;
  /** Custody actually opened by the native runtime, distinct from native auth. */
  readAppliedTeamCredentialModel?: () => TeamCredentialProviderModelSelectionV1 | null | undefined;
  revalidateBeforeEffect: () => Promise<boolean>;
}>;

export type SessionAppliedModelTransitionTarget = Readonly<
  { status: 'unavailable'; reason: SessionAppliedModelTransitionUnavailableReason }
  | { status: 'applied'; target: AuthorizedSessionModelTransitionTarget }
>;

export type SessionAppliedModelTransitionUnavailableReason =
  | 'not_accepting'
  | 'disposed'
  | 'publisher_authority_unavailable'
  | 'run_not_current'
  | 'reconciliation_required'
  | 'runtime_model_drift'
  | 'prompt_admission_fenced'
  | 'runtime_effect_in_progress'
  | 'runtime_model_unconfirmed'
  | 'active_target_changed';

export type SessionModelTransitionApplyResult =
  | Readonly<{ status: 'applied' }>
  | Readonly<{ status: 'deferred'; reason?: string }>
  | Readonly<{
      status: 'failed' | 'unsupported' | 'unproven' | 'requires_restart';
      reason?: string;
      failureCause?: SessionRuntimeIssueV1['failureCause'];
      readbackAfterCompletion?: boolean;
    }>;

/** The prompt loop owns reset bookkeeping; the coordinator owns its custody. */
export type SessionModelTransitionRestart = Readonly<{
  required: boolean;
  run: () => Promise<void>;
  /** The current native owner exposes whether replacement left any deliverable runtime. */
  getRuntimeLifetimeSignal?: () => AbortSignal | null | undefined;
}>;

/**
 * Plugin- and runtime-authored transition prose crosses the daemon boundary
 * into the Session transition result, Action details, and `--json` stdout, so
 * it enters through the canonical plugin-failure projector. Host-owned closed
 * reason codes are supplied as the fallback and are never rewritten.
 */
function projectSessionModelTransitionReason(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  return projectPluginFailureMessage(value);
}

export function mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult(
  outcome: RuntimeConfigUpdateOutcomeV1 | void | null,
): SessionModelTransitionApplyResult {
  if (outcome === undefined || outcome === null) {
    return {
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
      failureCause: classifyPrimarySessionRuntimeIssue({
        cause: 'session_error', startupPhase: 'turn_start',
      }).failureCause,
    };
  }
  if (isRuntimeConfigUpdateOutcomeDeferred(outcome)) {
    return { status: 'deferred' };
  }
  if (isRuntimeConfigUpdateOutcomeApplied(outcome)) {
    return { status: 'applied' };
  }
  return {
    status: outcome.status === 'requires_restart' ? 'requires_restart' : outcome.status === 'unsupported' ? 'unsupported' : 'failed',
    reason: projectSessionModelTransitionReason(
      outcome.reason,
      'runtime_model_transition_not_applied',
    ),
    failureCause: classifyPrimarySessionRuntimeIssue({
      cause: 'session_error', error: outcome.diagnostic, startupPhase: 'turn_start',
    }).failureCause,
  };
}

type Proposal = {
  restartRuntime?: SessionModelTransitionRestart;
  callerInputConstraints?: CallerInputConstraintsV1;
  captureBefore?: boolean;
  expected?: SessionModelMutationExpectedV1;
  capturedBefore?: ProviderBoundModelRef;
  committedIntentUpdatedAt?: number;
  selection: ProviderBoundModelRef;
  source: 'command' | 'metadata' | 'prompt';
  reuseInitialAdmission?: boolean;
  applyTiming?: 'immediate' | 'next_prompt';
  runWithActiveSelection: ((
    transferPromptAdmission: (opts: Readonly<{
      abortSignal: AbortSignal;
      dispatch: () => Promise<void>;
    }>) => Promise<
      | Readonly<{ status: 'dispatched'; value: void }>
      | Readonly<{ status: 'cancelled' }>
    >,
  ) => Promise<void>) | null;
  effectStarted: boolean;
  superseded: boolean;
  resolve: (result: SessionModelTransitionResultV1) => void;
  reject: (error: unknown) => void;
  promise: Promise<SessionModelTransitionResultV1>;
};

function sameSelection(
  left: ProviderBoundModelRef,
  right: ProviderBoundModelRef,
): boolean {
  return left.agentTargetKey === right.agentTargetKey
    && left.providerConnectionId === right.providerConnectionId
    && left.modelId === right.modelId;
}

function readTeamRoute(target: AuthorizedSessionModelTransitionTarget) {
  return target.readAppliedTeamCredentialModel ? target.readAppliedTeamCredentialModel() : null;
}

function sameTeamResourceBinding(
  desired: Extract<SessionModelSelectionV2['ref'], { source: 'team_resource' }>,
  applied: TeamCredentialProviderModelSelectionV1 | null | undefined,
): boolean {
  return applied != null
    && desired.agentTargetKey === applied.agentTargetKey
    && desired.resourceId === applied.resourceId
    && desired.teamId === applied.teamId
    && desired.expectedResourceRevision === applied.expectedResourceRevision
    && desired.deliveryMode === applied.deliveryMode
    && isDeepStrictEqual(desired.nativeDelivery ?? null, applied.nativeDelivery ?? null);
}

function sameTeamRoute(
  left: AuthorizedSessionModelTransitionTarget,
  right: AuthorizedSessionModelTransitionTarget,
): boolean {
  return JSON.stringify(readTeamRoute(left)) === JSON.stringify(readTeamRoute(right));
}

function sameAuthorizedTarget(
  left: AuthorizedSessionModelTransitionTarget,
  right: AuthorizedSessionModelTransitionTarget,
): boolean {
  if (!sameSelection(left.selection, right.selection) || !sameTeamRoute(left, right)) return false;
  if (left.selection.providerConnectionId === null) return true;
  return left.runtimeBindingBasis !== null
    && right.runtimeBindingBasis !== null
    && JSON.stringify(left.runtimeBindingBasis)
      === JSON.stringify(right.runtimeBindingBasis);
}

function samePublishedActiveFacts(
  left: AuthorizedSessionModelTransitionTarget,
  right: AuthorizedSessionModelTransitionTarget,
): boolean {
  return JSON.stringify({
    providerBinding: left.providerBinding,
    sessionBindingMetadata: left.sessionBindingMetadata,
    runtimeBindingBasis: left.runtimeBindingBasis,
    teamCredentialModel: readTeamRoute(left),
  }) === JSON.stringify({
    providerBinding: right.providerBinding,
    sessionBindingMetadata: right.sessionBindingMetadata,
    runtimeBindingBasis: right.runtimeBindingBasis,
    teamCredentialModel: readTeamRoute(right),
  });
}

function runtimeModelIdReadbackCanProveTarget(
  current: AuthorizedSessionModelTransitionTarget,
  candidate: AuthorizedSessionModelTransitionTarget,
): boolean {
  if (!sameTeamRoute(current, candidate)) return false;
  if (sameSelection(current.selection, candidate.selection)) {
    return samePublishedActiveFacts(current, candidate);
  }
  if (
    current.selection.agentTargetKey !== candidate.selection.agentTargetKey
    || current.selection.providerConnectionId
      !== candidate.selection.providerConnectionId
  ) {
    return false;
  }
  const bindingBasis = (
    target: AuthorizedSessionModelTransitionTarget,
  ): unknown => target.providerBinding === null
    ? null
    : {
        source: target.providerBinding.source
          ?? { kind: 'account_provider_connection', connectionId: target.providerBinding.connectionId },
        materialization: target.providerBinding.materialization,
      };
  const metadataBasis = (
    target: AuthorizedSessionModelTransitionTarget,
  ): unknown => {
    if (target.sessionBindingMetadata === null) return null;
    const {
      model: _model,
      bindingSecurityFingerprint: _bindingSecurityFingerprint,
      ...modelIndependentMetadata
    } = target.sessionBindingMetadata;
    return modelIndependentMetadata;
  };
  return JSON.stringify({
    providerBinding: bindingBasis(current),
    sessionBindingMetadata: metadataBasis(current),
    runtimeBindingBasis: current.runtimeBindingBasis,
  }) === JSON.stringify({
    providerBinding: bindingBasis(candidate),
    sessionBindingMetadata: metadataBasis(candidate),
    runtimeBindingBasis: candidate.runtimeBindingBasis,
  });
}

function failure(
  status: Exclude<
    Extract<SessionModelTransitionResultV1, { ok: false }>['status'],
    never
  >,
  activeSelection: ProviderBoundModelRef,
  requestedSelection: ProviderBoundModelRef,
  reason?: string,
  failureCause?: SessionRuntimeIssueV1['failureCause'],
): Extract<SessionModelTransitionResultV1, { ok: false }> {
  return {
    ok: false,
    status,
    activeSelection,
    requestedSelection,
    ...(reason ? { reason } : {}),
    ...(failureCause ? { failureCause } : {}),
  };
}

function reconciliationFailure(
  activeSelection: ProviderBoundModelRef | null,
  requestedSelection: ProviderBoundModelRef,
  reason?: string,
  failureCause?: SessionRuntimeIssueV1['failureCause'],
): Extract<
  SessionModelTransitionResultV1,
  { ok: false; status: 'reconciliation_required' }
> {
  return {
    ok: false,
    status: 'reconciliation_required',
    activeSelection,
    requestedSelection,
    ...(reason ? { reason } : {}),
    ...(failureCause ? { failureCause } : {}),
  };
}

/**
 * The exact running session owns this bounded scheduler. It deliberately keeps
 * only one operation that may have an effect and the latest not-yet-effectful
 * proposal; persisted intent remains the sole durable requested-selection
 * projection.
 */
export function createSessionModelTransitionCoordinator(params: Readonly<{
  runId: string;
  agentTargetKey: string;
  ownerScope?: SessionModelMutationScopeV1;
  initialActiveTarget: AuthorizedSessionModelTransitionTarget;
  initialActiveTargetConfirmed: boolean;
  /** Current durable source, distinct from the route still opened until restart. */
  readModelSelectionIntent: () => SessionModelSelectionV2 | null;
  isCurrentRun: () => boolean;
  checkCurrentPublisherAuthority: () => Promise<boolean>;
  authorize: (
    selection: ProviderBoundModelRef,
    callerInputConstraints?: CallerInputConstraintsV1,
  ) => Promise<AuthorizedSessionModelTransitionTarget>;
  publishIntent: (
    selection: ProviderBoundModelRef,
    expected?: Readonly<{ selection: ProviderBoundModelRef; updatedAt: number }>,
    requiredBefore?: ProviderBoundModelRef,
  ) => Promise<Readonly<{ accepted: boolean; updatedAt: number }>>;
  applyRuntime: (
    target: AuthorizedSessionModelTransitionTarget,
  ) => Promise<SessionModelTransitionApplyResult>;
  publishActive: (
    target: AuthorizedSessionModelTransitionTarget,
    evidence?: 'runtime_apply' | 'runtime_readback' | null,
  ) => Promise<void>;
  revokeActiveSelectionProof: (
    selection: ProviderBoundModelRef,
  ) => Promise<void>;
  fencePromptAdmission: (epochId: string) => Promise<void>;
  clearPromptAdmission: (epochId: string) => Promise<void>;
  transferPromptAdmission: (
    epochId: string,
    opts: Readonly<{
      abortSignal: AbortSignal;
      dispatch: () => Promise<void>;
    }>,
  ) => Promise<
    | Readonly<{ status: 'dispatched'; value: void }>
    | Readonly<{ status: 'cancelled' }>
  >;
  readRuntimeModelId?: () => Promise<string | null> | string | null;
  subscribeRuntimeModelChanges?: (
    handler: (currentModelId?: string | null) => void,
  ) => () => void;
}>): Readonly<{
  submit: (
    selection: ProviderBoundModelRef,
    context: Readonly<{
      source: Proposal['source'];
      /** Startup echo of the validated launch handoff; other metadata reauthorizes. */
      reuseInitialAdmission?: boolean;
      applyTiming?: 'immediate' | 'next_prompt';
      callerInputConstraints?: CallerInputConstraintsV1;
      runWithActiveSelection?: NonNullable<Proposal['runWithActiveSelection']>;
      restartRuntime?: SessionModelTransitionRestart;
      captureBefore?: boolean;
      expected?: SessionModelMutationExpectedV1;
    }>,
  ) => Promise<SessionModelTransitionResultV1>;
  /**
   * A replacement runtime has opened under this exact already-admitted target.
   * It may refresh non-selection binding facts, but it cannot choose a target.
   */
  admitReplacementTarget: (
    target: AuthorizedSessionModelTransitionTarget,
  ) => Promise<void>;
  readActiveTarget: () => AuthorizedSessionModelTransitionTarget;
  readReplacementTarget: () => AuthorizedSessionModelTransitionTarget;
  /** Pending command or Team model intent that needs the next prompt's transition custody. */
  readArmedSelection: () => ProviderBoundModelRef | null;
  /** Restore applied intent through this same command queue; callers never guess the active route. */
  unarm: (callerInputConstraints?: CallerInputConstraintsV1) => Promise<SessionModelTransitionResultV1>;
  readAppliedTarget: () => Promise<SessionAppliedModelTransitionTarget>;
  runWithStableActiveTarget: <T>(
    effect: (
      target: AuthorizedSessionModelTransitionTarget,
      runWithCurrentPublisherPermit: <U>(
        localEffect: () => Promise<U>,
      ) => Promise<
        | Readonly<{ status: 'completed'; value: U }>
        | Readonly<{ status: 'blocked'; failureCause?: SessionRuntimeIssueV1['failureCause'] }>
      >,
    ) => Promise<T>,
  ) => Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked'; failureCause?: SessionRuntimeIssueV1['failureCause'] }>
  >;
  dispose: () => Promise<void>;
}> {
  let activeTarget = params.initialActiveTarget;
  let runtimeReplacementTarget: AuthorizedSessionModelTransitionTarget | null = null;
  let observedAppliedTarget = params.initialActiveTargetConfirmed === false
    ? null : params.initialActiveTarget;
  let current: Proposal | null = null;
  let pending: Proposal | null = null;
  let pumpPromise: Promise<void> | null = null;
  let transitionOrdinal = 0;
  let accepting = true;
  let disposed = false;
  let disposalPromise: Promise<void> | null = null;
  let reconciliationRequired = false;
  let reconciliationActiveSelection: ProviderBoundModelRef | null =
    activeTarget.selection;
  let reconciliationTargets: readonly AuthorizedSessionModelTransitionTarget[] =
    [];
  let runtimeObservedDriftModelId: string | null = null;
  let readbackReconciliationRequested = false;
  let activeFenceEpochId: string | null = null;
  let unsubscribeRuntimeModelChanges: (() => void) | null = null;
  let expectedRuntimeEffectModelId: string | null = null;
  let runtimeObservationRevision = 0;
  let latestRuntimeObservedModelId: string | null = null;
  let stableActiveTargetEffect = false;
  let stableActiveTargetEffectSettled: Promise<void> | null = null;
  let publisherAuthorityUnavailable = false;
  let armedSelection: ProviderBoundModelRef | null = null;
  // An accepted configuration owns dispatch, but only runtime evidence owns
  // Running. Retain its prior materialization basis for model-only readback.
  let awaitingRuntimeConfirmation = params.initialActiveTargetConfirmed === false
    ? { basis: params.initialActiveTarget }
    : null;

  const isCurrent = (): boolean =>
    !disposed
    && !publisherAuthorityUnavailable
    && params.isCurrentRun();

  const readAppliedTargetUnavailableReason = (): SessionAppliedModelTransitionUnavailableReason | null => {
    if (!accepting) return 'not_accepting';
    if (disposed) return 'disposed';
    if (publisherAuthorityUnavailable) return 'publisher_authority_unavailable';
    if (!params.isCurrentRun()) return 'run_not_current';
    if (reconciliationRequired) return 'reconciliation_required';
    if (runtimeObservedDriftModelId !== null) return 'runtime_model_drift';
    if (activeFenceEpochId !== null) return 'prompt_admission_fenced';
    if (current?.effectStarted === true) return 'runtime_effect_in_progress';
    if (observedAppliedTarget === null) return 'runtime_model_unconfirmed';
    return null;
  };

  const readAppliedTarget = async (): Promise<SessionAppliedModelTransitionTarget> => {
    const reason = readAppliedTargetUnavailableReason();
    if (reason) return { status: 'unavailable', reason };
    const target = observedAppliedTarget;
    if (target === null) return { status: 'unavailable', reason: 'runtime_model_unconfirmed' };
    if (!(await targetAuthorizationStillCurrent(target)).current) {
      if (observedAppliedTarget === target) observedAppliedTarget = null;
      return { status: 'unavailable', reason: 'runtime_model_unconfirmed' };
    }
    const result = await runWithCurrentPublisherPermit(async (): Promise<SessionAppliedModelTransitionTarget> => {
      const reason = readAppliedTargetUnavailableReason();
      if (reason) return { status: 'unavailable', reason };
      return observedAppliedTarget === target
        ? { status: 'applied', target }
        : { status: 'unavailable', reason: 'active_target_changed' };
    });
    return result.status === 'completed' ? result.value : {
      status: 'unavailable',
      reason: readAppliedTargetUnavailableReason() ?? 'publisher_authority_unavailable',
    };
  };

  const runWithCurrentPublisherPermit = async <T>(
    localEffect: () => Promise<T>,
  ): Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked'; failureCause?: SessionRuntimeIssueV1['failureCause'] }>
  > => {
    if (!isCurrent()) return { status: 'blocked' };
    let current: boolean;
    try {
      current = await params.checkCurrentPublisherAuthority();
    } catch (error) {
      publisherAuthorityUnavailable = true;
      return { status: 'blocked', failureCause: projectSessionRuntimeFailureCause(error, 'turn_start') };
    }
    if (!current || !isCurrent()) {
      publisherAuthorityUnavailable = true;
      return { status: 'blocked' };
    }
    return {
      status: 'completed',
      // The exact-current check grants only this immediate local invocation.
      // There is deliberately no intervening await before custody is consumed.
      value: await localEffect(),
    };
  };

  const requireCurrentPublisherPermit = async <T>(
    localEffect: () => Promise<T>,
  ): Promise<T> => {
    const result = await runWithCurrentPublisherPermit(localEffect);
    if (result.status === 'blocked') {
      throw Object.assign(new Error('session_publisher_authority_lost'), {
        ...(result.failureCause ? { failureCause: result.failureCause } : {}),
      });
    }
    return result.value;
  };

  const completeSuperseded = (proposal: Proposal): void => {
    proposal.resolve(failure(
      'superseded',
      activeTarget.selection,
      proposal.selection,
    ));
  };

  const replacePending = (proposal: Proposal): void => {
    if (pending) {
      pending.superseded = true;
      completeSuperseded(pending);
    }
    pending = proposal;
  };

  const safelyApply = async (
    target: AuthorizedSessionModelTransitionTarget,
  ): Promise<SessionModelTransitionApplyResult> => {
    try {
      return await params.applyRuntime(target);
    } catch (error) {
      return {
        status: 'unproven',
        reason: projectSessionModelTransitionReason(
          error instanceof Error ? error.message : null,
          'runtime_apply_failed',
        ),
        readbackAfterCompletion: true,
        failureCause: classifyPrimarySessionRuntimeIssue({
          cause: 'session_error', error, startupPhase: 'turn_start',
        }).failureCause,
      };
    }
  };

  const targetAuthorizationStillCurrent = async (
    target: AuthorizedSessionModelTransitionTarget,
  ): Promise<Readonly<{ current: boolean; failureCause?: SessionRuntimeIssueV1['failureCause'] }>> => {
    if (target.selection.providerConnectionId === null && target.providerBinding === null) return { current: true };
    if (typeof target.revalidateBeforeEffect !== 'function') return { current: false };
    try {
      return { current: await target.revalidateBeforeEffect() };
    } catch (error) {
      return { current: false, failureCause: projectSessionRuntimeFailureCause(error, 'turn_start') };
    }
  };

  const publishConfiguredTarget = async (
    target: AuthorizedSessionModelTransitionTarget,
  ): Promise<void> => {
    const basis = awaitingRuntimeConfirmation?.basis ?? activeTarget;
    await params.publishActive(target, null);
    if (!isCurrent()) throw new Error('session_publisher_authority_lost');
    const authorization = await targetAuthorizationStillCurrent(target);
    if (!authorization.current) {
      throw Object.assign(new Error('provider_authorization_changed_during_publication'), { failureCause: authorization.failureCause });
    }
    if (!isCurrent()) throw new Error('session_publisher_authority_lost');
    activeTarget = target;
    awaitingRuntimeConfirmation = { basis };
    if (observedAppliedTarget && (!runtimeModelIdReadbackCanProveTarget(basis, target)
      || !runtimeModelIdReadbackCanProveTarget(basis, observedAppliedTarget))) {
      observedAppliedTarget = null;
    }
    armedSelection = null;
    readbackReconciliationRequested = true;
  };

  const successfulProposalResult = (
    proposal: Proposal,
    status: 'applied' | 'already_active',
  ): SessionModelTransitionResultV1 => awaitingRuntimeConfirmation
    ? { ok: true, status: 'armed', activeSelection: awaitingRuntimeConfirmation.basis.selection,
        requestedSelection: proposal.selection }
    : { ok: true, status, activeSelection: activeTarget.selection };

  const clearActiveFence = async (): Promise<void> => {
    if (!activeFenceEpochId) return;
    const epochId = activeFenceEpochId;
    await requireCurrentPublisherPermit(
      async () => await params.clearPromptAdmission(epochId),
    );
    if (activeFenceEpochId === epochId) {
      activeFenceEpochId = null;
    }
  };

  const clearActiveFenceUnlessPendingSuccessor = async (): Promise<void> => {
    if (
      reconciliationRequired
      || (pending && accepting && isCurrent())
    ) return;
    await clearActiveFence();
  };

  const ensureActiveFence = async (): Promise<void> => {
    if (activeFenceEpochId) return;
    const epochId =
      `model-transition:${params.runId}:${++transitionOrdinal}`;
    await params.fencePromptAdmission(epochId);
    if (isCurrent()) {
      activeFenceEpochId = epochId;
    }
  };

  const settleBeforeRuntimeEffect = async (
    proposal: Proposal,
    result: SessionModelTransitionResultV1,
  ): Promise<void> => {
    const retainFenceForPendingSuccessor =
      proposal.superseded
      && pending !== null
      && accepting
      && isCurrent();
    if (
      activeFenceEpochId
      && !retainFenceForPendingSuccessor
      && isCurrent()
    ) {
      try {
        await clearActiveFence();
      } catch {
        if (!isCurrent()) {
          proposal.resolve(failure(
            'owner_unavailable',
            activeTarget.selection,
            proposal.selection,
          ));
          return;
        }
        reconciliationRequired = true;
        reconciliationActiveSelection = activeTarget.selection;
        reconciliationTargets = [activeTarget];
        proposal.resolve(reconciliationFailure(
          reconciliationActiveSelection,
          proposal.selection,
          'prompt_fence_release_failed',
        ));
        return;
      }
    }
    proposal.resolve(result);
  };

  const settleIfInterruptedBeforeRuntimeEffect = async (
    proposal: Proposal,
  ): Promise<boolean> => {
    if (!isCurrent() || !accepting) {
      await settleBeforeRuntimeEffect(proposal, failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return true;
    }
    if (reconciliationRequired) {
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'runtime_model_drift_observed',
      ));
      return true;
    }
    if (proposal.superseded) {
      await settleBeforeRuntimeEffect(proposal, failure(
        'superseded',
        activeTarget.selection,
        proposal.selection,
      ));
      return true;
    }
    return false;
  };

  const runPromptCustodyAfterSuccessfulTransition = async (
    proposal: Proposal,
  ): Promise<'not_requested' | 'completed' | 'settled'> => {
    const runWithActiveSelection = proposal.runWithActiveSelection;
    if (!runWithActiveSelection) return 'not_requested';

    // Prompt custody is an irreversible scheduler phase even when the target
    // was already active. A newer setting may become the latest pending
    // proposal, but it cannot replace this prompt between exact selection
    // activation and Provider acceptance.
    proposal.effectStarted = true;
    try {
      await ensureActiveFence();
    } catch (error) {
      proposal.resolve(failure(
        'apply_failed',
        activeTarget.selection,
        proposal.selection,
        projectSessionModelTransitionReason(
          error instanceof Error ? error.message : null,
          'prompt_fence_failed',
        ),
      ));
      return 'settled';
    }
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return 'settled';
    }
    if (reconciliationRequired || runtimeObservedDriftModelId !== null) {
      try {
        await ensureActiveFence();
      } catch {
        reconciliationRequired = true;
      }
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'runtime_model_drift_observed_before_prompt_custody',
      ));
      return 'settled';
    }

    const fenceEpochId = activeFenceEpochId;
    if (!fenceEpochId) {
      reconciliationRequired = true;
      reconciliationActiveSelection = activeTarget.selection;
      reconciliationTargets = [activeTarget];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'prompt_fence_missing_before_custody_transfer',
      ));
      return 'settled';
    }
    let transferInvoked = false;
    try {
      await runWithActiveSelection(async (dispatchOpts) => {
        if (transferInvoked) {
          throw new Error(
            'Prompt custody may consume its transition admission only once',
          );
        }
        try {
          const transfer = await runWithCurrentPublisherPermit(async () => {
            transferInvoked = true;
            return await params.transferPromptAdmission(
              fenceEpochId,
              dispatchOpts,
            );
          });
          if (transfer.status === 'blocked') {
            throw Object.assign(new Error('session_publisher_authority_lost'), {
              ...(transfer.failureCause ? { failureCause: transfer.failureCause } : {}),
            });
          }
          return transfer.value;
        } finally {
          // The transfer owner consumes this exact admission on dispatch
          // success, cancellation, and Provider error.
          if (
            transferInvoked
            && activeFenceEpochId === fenceEpochId
          ) {
            activeFenceEpochId = null;
          }
        }
      });
    } catch (error) {
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return 'settled';
      }
      if (!transferInvoked) {
        try {
          await clearActiveFence();
        } catch {
          reconciliationRequired = true;
          reconciliationActiveSelection = activeTarget.selection;
          reconciliationTargets = [activeTarget];
        }
      }
      proposal.reject(error);
      return 'settled';
    }
    if (!transferInvoked) {
      try {
        await clearActiveFence();
      } catch {
        reconciliationRequired = true;
        reconciliationActiveSelection = activeTarget.selection;
        reconciliationTargets = [activeTarget];
      }
      proposal.reject(new Error(
        'Prompt custody callback did not consume the transition admission',
      ));
      return 'settled';
    }
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return 'settled';
    }
    if (reconciliationRequired || runtimeObservedDriftModelId !== null) {
      try {
        await ensureActiveFence();
      } catch {
        reconciliationRequired = true;
      }
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'runtime_model_drift_observed_during_prompt_custody',
      ));
      return 'settled';
    }
    return 'completed';
  };

  const recoverAppliedTargetFromRuntimeReadback = async (
    proposal: Proposal,
    target: AuthorizedSessionModelTransitionTarget,
    failureCause?: SessionRuntimeIssueV1['failureCause'],
  ): Promise<Readonly<{ recovered: boolean; failureCause?: SessionRuntimeIssueV1['failureCause'] }>> => {
    if (!params.readRuntimeModelId) return { recovered: false };
    const settleContradictoryReadback = async (
      reason: string,
    ): Promise<Readonly<{ recovered: boolean; failureCause?: SessionRuntimeIssueV1['failureCause'] }>> => {
      reconciliationRequired = true;
      reconciliationActiveSelection = null;
      reconciliationTargets = [];
      try {
        await ensureActiveFence();
      } catch {
        reconciliationRequired = true;
      }
      proposal.resolve(reconciliationFailure(
        null,
        proposal.selection,
        reason,
        failureCause,
      ));
      return { recovered: true };
    };
    const readbackObservationRevision = runtimeObservationRevision;
    let modelId: string | null;
    try {
      const rawModelId = await params.readRuntimeModelId();
      modelId = readNonBlankOpaqueIdentifier(rawModelId);
    } catch (error) {
      return { recovered: false, failureCause: projectSessionRuntimeFailureCause(error, 'turn_start') };
    }
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return { recovered: true };
    }
    if (modelId !== target.selection.modelId) return { recovered: false };
    if (!runtimeModelIdReadbackCanProveTarget(awaitingRuntimeConfirmation?.basis ?? activeTarget, target)) {
      return { recovered: false };
    }
    if (
      runtimeObservedDriftModelId !== null
      || reconciliationRequired
      || (
        runtimeObservationRevision !== readbackObservationRevision
        && latestRuntimeObservedModelId !== target.selection.modelId
      )
    ) {
      return await settleContradictoryReadback(
        'runtime_model_drift_observed_during_readback',
      );
    }
    const revalidationObservationRevision = runtimeObservationRevision;
    const authorization = await targetAuthorizationStillCurrent(target);
    if (!authorization.current) {
      return { recovered: false, failureCause: authorization.failureCause };
    }
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return { recovered: true };
    }
    if (
      runtimeObservedDriftModelId !== null
      || reconciliationRequired
      || (
        runtimeObservationRevision !== revalidationObservationRevision
        && latestRuntimeObservedModelId !== target.selection.modelId
      )
    ) {
      return await settleContradictoryReadback(
        'runtime_model_drift_observed_during_readback_revalidation',
      );
    }
    try {
      await params.publishActive(target, 'runtime_readback');
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return { recovered: true };
      }
      if (runtimeObservedDriftModelId !== null || reconciliationRequired) {
        return await settleContradictoryReadback(
          'runtime_model_drift_observed_during_readback_publication',
        );
      }
      const publicationAuthorization = await targetAuthorizationStillCurrent(target);
      if (!publicationAuthorization.current) {
        failureCause = publicationAuthorization.failureCause ?? failureCause;
        return await settleContradictoryReadback(
          'provider_authorization_changed_during_readback_publication',
        );
      }
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return { recovered: true };
      }
      if (runtimeObservedDriftModelId !== null || reconciliationRequired) {
        return await settleContradictoryReadback(
          'runtime_model_drift_observed_during_readback_publication_revalidation',
        );
      }
      activeTarget = target;
      observedAppliedTarget = target;
      awaitingRuntimeConfirmation = null;
      armedSelection = null;
      const promptCustody =
        await runPromptCustodyAfterSuccessfulTransition(proposal);
      if (promptCustody === 'settled') return { recovered: true };
      if (promptCustody === 'not_requested') {
        await clearActiveFenceUnlessPendingSuccessor();
      }
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return { recovered: true };
      }
      if (runtimeObservedDriftModelId !== null || reconciliationRequired) {
        return await settleContradictoryReadback(
          'runtime_model_drift_observed_during_readback_fence_release',
        );
      }
      proposal.resolve({
        ok: true,
        status: 'applied',
        activeSelection: activeTarget.selection,
      });
      return { recovered: true };
    } catch (error) {
      reconciliationRequired = true;
      reconciliationActiveSelection = target.selection;
      reconciliationTargets = [target];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'runtime_readback_publication_failed',
        projectSessionRuntimeFailureCause(error, 'turn_start') ?? failureCause,
      ));
      return { recovered: true };
    }
  };

  const processProposal = async (proposal: Proposal): Promise<void> => {
    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
    if (reconciliationRequired) {
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
      ));
      return;
    }
    if (proposal.expected) {
      const expected = proposal.expected;
      const scope = params.ownerScope;
      if (expected.owner !== 'active' || !scope || expected.runId !== params.runId
        || expected.scope.serverId !== scope.serverId
        || expected.scope.accountId !== scope.accountId
        || expected.scope.sessionId !== scope.sessionId
        || !sameSelection(expected.selection, activeTarget.selection)) {
        await settleBeforeRuntimeEffect(proposal, failure('superseded', activeTarget.selection, proposal.selection));
        return;
      }
    }
    if (proposal.captureBefore && !params.ownerScope) {
      await settleBeforeRuntimeEffect(proposal, failure('unsupported', activeTarget.selection, proposal.selection, 'exact_model_mutation_scope_unavailable'));
      return;
    }
    if ((proposal.captureBefore || proposal.expected) && observedAppliedTarget === null) {
      await settleBeforeRuntimeEffect(proposal, failure('unsupported', activeTarget.selection,
        proposal.selection, 'exact_model_mutation_requires_confirmed_runtime'));
      return;
    }
    let target: AuthorizedSessionModelTransitionTarget;
    // A prompt carries a model tuple without its Team source. Keep the
    // opened source, and reopen its model-specific materialization when only
    // the brokered model changed. The broker still admits that exact model.
    const desiredModel = proposal.source === 'prompt' ? params.readModelSelectionIntent() : null;
    const activeTeam = readTeamRoute(activeTarget);
    let carriesActiveTeamSelection = false;
    if (proposal.source === 'prompt'
      && proposal.selection.providerConnectionId === null
      && desiredModel?.ref.source === 'team_resource'
      && desiredModel.ref.agentTargetKey === proposal.selection.agentTargetKey
      && desiredModel.ref.modelId === proposal.selection.modelId) {
      if (!sameTeamResourceBinding(desiredModel.ref, activeTeam)
        || (!sameSelection(activeTarget.selection, proposal.selection)
          && desiredModel.ref.deliveryMode !== 'brokered')) {
        // A newly selected Team source is waiting for restart. Its V1 prompt
        // projection cannot authorize either the old source or native execution.
        await settleBeforeRuntimeEffect(proposal, failure('restart_required', activeTarget.selection,
          proposal.selection, 'team_resource_binding_changed'));
        return;
      }
      carriesActiveTeamSelection = true;
    }
    // Startup metadata echoes the Provider already admitted by the launch
    // handoff. Runtime readback does not make that echo a new admission.
    const carriesOpenedProviderSelection = proposal.reuseInitialAdmission === true
      && proposal.source === 'metadata'
      && activeTarget === params.initialActiveTarget
      && activeTarget.providerBinding != null
      && sameSelection(activeTarget.selection, proposal.selection)
      && proposal.callerInputConstraints === undefined;
    try {
      target = (carriesActiveTeamSelection && sameSelection(activeTarget.selection, proposal.selection))
        || carriesOpenedProviderSelection ? activeTarget
        : await params.authorize(proposal.selection, proposal.callerInputConstraints);
      if (carriesActiveTeamSelection && target !== activeTarget) {
        // The broker materialization is model-bound even when the Agent can
        // otherwise update native models live. Reopen it at this turn boundary.
        target = { ...target, policy: 'restart_session', readAppliedTeamCredentialModel: activeTarget.readAppliedTeamCredentialModel };
      }
    } catch (error) {
      if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
      await settleBeforeRuntimeEffect(proposal, failure(
        'unsupported',
        activeTarget.selection,
        proposal.selection,
        projectSessionModelTransitionReason(
          error instanceof Error ? error.message : null,
          'model_transition_authorization_failed',
        ),
        classifyPrimarySessionRuntimeIssue({
          cause: 'session_error', error, startupPhase: 'turn_start',
        }).failureCause,
      ));
      return;
    }
    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
    if (!sameSelection(target.selection, proposal.selection)) {
      await settleBeforeRuntimeEffect(proposal, failure(
        'unsupported',
        activeTarget.selection,
        proposal.selection,
        'authorized_selection_mismatch',
      ));
      return;
    }
    if (target.policy === 'unsupported') {
      await settleBeforeRuntimeEffect(proposal, failure(
        'unsupported',
        activeTarget.selection,
        proposal.selection,
      ));
      return;
    }
    if (proposal.captureBefore && target.policy !== 'live') {
      await settleBeforeRuntimeEffect(proposal, failure('unsupported', activeTarget.selection, proposal.selection, 'exact_model_mutation_requires_live_transition'));
      return;
    }
    if (proposal.captureBefore) proposal.capturedBefore = activeTarget.selection;

    // Metadata proposals are observations of an intent that already won the
    // durable CAS. Republishing them would mint a newer timestamp and feed the
    // metadata synchronizer back into this coordinator indefinitely.
    if (proposal.source !== 'metadata' && !carriesActiveTeamSelection) {
      // A durable CAS that has started must finish, but it is not the runtime
      // effect boundary. A newer proposal may still supersede this one; the
      // newer CAS runs afterward so accepted intent order remains preserved.
      try {
        const publication = proposal.expected || proposal.capturedBefore
          ? await params.publishIntent(proposal.selection,
            proposal.expected ? { selection: proposal.expected.selection, updatedAt: proposal.expected.updatedAt } : undefined,
            proposal.capturedBefore)
          : await params.publishIntent(proposal.selection);
        if (!publication.accepted) {
          await settleBeforeRuntimeEffect(proposal, failure(
            'superseded',
            activeTarget.selection,
            proposal.selection,
            'accepted_intent_was_superseded',
          ));
          return;
        }
        proposal.committedIntentUpdatedAt = publication.updatedAt;
      } catch (error) {
        if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
        await settleBeforeRuntimeEffect(proposal, failure(
          'apply_failed',
          activeTarget.selection,
          proposal.selection,
          projectSessionModelTransitionReason(
            error instanceof Error ? error.message : null,
            'intent_publication_failed',
          ),
          projectSessionRuntimeFailureCause(error, 'turn_start'),
        ));
        return;
      }
    }
    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
    if (pending && !pending.captureBefore && !pending.expected) {
      proposal.superseded = true;
      await settleBeforeRuntimeEffect(proposal, failure(
        'superseded',
        activeTarget.selection,
        proposal.selection,
        'newer_intent_pending_before_runtime_effect',
      ));
      return;
    }

    // The durable intent is the restart/reconnect source of truth. Publish the
    // current target even when it is already active so choosing it cancels any
    // previously persisted restart-required proposal.
    if (
      proposal.restartRuntime?.required !== true
      && sameAuthorizedTarget(activeTarget, target)
      && samePublishedActiveFacts(activeTarget, target)
    ) {
      armedSelection = null;
      const promptCustody =
        await runPromptCustodyAfterSuccessfulTransition(proposal);
      if (promptCustody === 'settled') return;
      if (promptCustody === 'completed') {
        proposal.resolve(successfulProposalResult(proposal, 'already_active'));
        return;
      }
      await settleBeforeRuntimeEffect(proposal, successfulProposalResult(proposal, 'already_active'));
      return;
    }

    if (target.policy === 'restart_session' && !proposal.restartRuntime) {
      armedSelection = proposal.selection;
      // The admitted selection itself needs a restart only when its Provider
      // binding changed after admission (endpoint/credential/re-consent). Name
      // that closed Provider refusal so callers present its restart recovery.
      await settleBeforeRuntimeEffect(proposal, failure(
        'restart_required',
        activeTarget.selection,
        proposal.selection,
        sameSelection(activeTarget.selection, proposal.selection) ? 'provider_binding_changed' : undefined,
      ));
      return;
    }

    if (proposal.applyTiming === 'next_prompt'
      || (proposal.source === 'metadata' && armedSelection && sameSelection(armedSelection, proposal.selection))) {
      armedSelection = proposal.selection;
      await settleBeforeRuntimeEffect(proposal, { ok: true, status: 'armed',
        activeSelection: activeTarget.selection, requestedSelection: proposal.selection });
      return;
    }
    if (armedSelection && !sameSelection(armedSelection, proposal.selection)) armedSelection = null;

    const previousTarget = activeTarget;
    if (!activeFenceEpochId) {
      const epochId =
        `model-transition:${params.runId}:${++transitionOrdinal}`;
      try {
        await params.fencePromptAdmission(epochId);
        activeFenceEpochId = epochId;
      } catch (error) {
        if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
        await settleBeforeRuntimeEffect(proposal, failure(
          'apply_failed',
          activeTarget.selection,
          proposal.selection,
          projectSessionModelTransitionReason(
            error instanceof Error ? error.message : null,
            'prompt_fence_failed',
          ),
        ));
        return;
      }
    }
    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;

    if (target.selection.providerConnectionId !== null || target.providerBinding !== null) {
      const authorizationStillCurrent =
        await targetAuthorizationStillCurrent(target);
      if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
      if (!authorizationStillCurrent.current) {
        try {
          await clearActiveFence();
        } catch {
          if (!isCurrent()) {
            proposal.resolve(failure(
              'owner_unavailable',
              activeTarget.selection,
              proposal.selection,
            ));
            return;
          }
          reconciliationRequired = true;
          reconciliationActiveSelection = activeTarget.selection;
          reconciliationTargets = [activeTarget];
          proposal.resolve(reconciliationFailure(
            reconciliationActiveSelection,
            proposal.selection,
            'prompt_fence_release_failed',
          ));
          return;
        }
        if (!isCurrent()) {
          proposal.resolve(failure(
            'owner_unavailable',
            activeTarget.selection,
            proposal.selection,
          ));
          return;
        }
        proposal.resolve(failure(
          'apply_failed',
          activeTarget.selection,
          proposal.selection,
          'provider_authorization_changed_before_effect',
          authorizationStillCurrent.failureCause,
        ));
        return;
      }
    }

    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
    let forwardEffectObservationRevision = runtimeObservationRevision;
    let replacementLifetimeEnded = false;
    const permittedApply = await runWithCurrentPublisherPermit(async () => {
      // This immediate invocation is the runtime-effect boundary. From this
      // synchronous point onward, the operation must reconcile the effect it
      // may have caused.
      proposal.effectStarted = true;
      forwardEffectObservationRevision = runtimeObservationRevision;
      expectedRuntimeEffectModelId = target.selection.modelId;
      const restart = proposal.restartRuntime;
      let applied: SessionModelTransitionApplyResult = target.policy === 'restart_session' || restart?.required === true
        ? { status: 'requires_restart' as const }
        : await safelyApply(target);
      if (applied.status === 'requires_restart' && restart) {
        runtimeReplacementTarget = target;
        try {
          await restart.run();
          target = runtimeReplacementTarget;
          applied = await safelyApply(target);
        } catch (error) {
          const lifetimeEnded = restart.getRuntimeLifetimeSignal?.()?.aborted === true;
          applied = { status: 'unproven', readbackAfterCompletion: !lifetimeEnded,
            reason: projectSessionModelTransitionReason(error instanceof Error ? error.message : null, 'runtime_apply_failed'),
            failureCause: classifyPrimarySessionRuntimeIssue({
              cause: 'session_error', error, startupPhase: 'turn_start',
            }).failureCause };
          if (lifetimeEnded) {
            observedAppliedTarget = null;
            awaitingRuntimeConfirmation = null;
            try {
              await params.revokeActiveSelectionProof(activeTarget.selection);
              // Evidence from the retired runtime cannot prove a live apply or
              // keep later input behind reconciliation. It must reopen first.
              replacementLifetimeEnded = true;
              runtimeObservedDriftModelId = null;
              applied = { ...applied, status: 'failed' };
            } catch {
              // Keep the model fence when withdrawing old active proof fails;
              // retain the original replacement cause for the failed prompt.
            }
          }
        } finally {
          runtimeReplacementTarget = null;
        }
      }
      return applied;
    });
    if (permittedApply.status === 'blocked') {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
        undefined,
        permittedApply.failureCause,
      ));
      return;
    }
    const applied = permittedApply.value;
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return;
    }
    if (
      !replacementLifetimeEnded
      && applied.status !== 'applied'
      && applied.status !== 'deferred'
      && applied.status !== 'unproven'
      && runtimeObservationRevision !== forwardEffectObservationRevision
      && latestRuntimeObservedModelId === target.selection.modelId
    ) {
      runtimeObservedDriftModelId = target.selection.modelId;
      reconciliationRequired = true;
      reconciliationActiveSelection = null;
      reconciliationTargets = [target, previousTarget];
      proposal.resolve(reconciliationFailure(
        null,
        proposal.selection,
        'runtime_effect_observed_after_failed_apply',
        applied.failureCause,
      ));
      return;
    }
    if (runtimeObservedDriftModelId !== null) {
      proposal.resolve(reconciliationFailure(
        null,
        proposal.selection,
        'runtime_model_drift_observed_during_transition',
        'failureCause' in applied ? applied.failureCause : undefined,
      ));
      return;
    }
    if (applied.status === 'unproven') {
      const readback = applied.readbackAfterCompletion === true
        ? await recoverAppliedTargetFromRuntimeReadback(proposal, target, applied.failureCause)
        : null;
      if (readback?.recovered) return;
      reconciliationRequired = true;
      reconciliationActiveSelection = null;
      reconciliationTargets = [target];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        applied.reason ?? 'runtime_model_transition_outcome_unproven',
        readback?.failureCause ?? applied.failureCause,
      ));
      return;
    }
    if (applied.status !== 'applied' && applied.status !== 'deferred') {
      if (applied.status === 'requires_restart') armedSelection = proposal.selection;
      let reason = applied.reason;
      let failureCause = applied.failureCause;
      if (applied.status === 'failed' && proposal.source === 'prompt'
        && proposal.committedIntentUpdatedAt !== undefined
        && (replacementLifetimeEnded || (armedSelection && sameSelection(armedSelection, proposal.selection)))) {
        try {
          // This prompt consumed its failed choice. Restore the prior configured
          // intent only while this proposal still owns the durable selection.
          const restored = await params.publishIntent(activeTarget.selection, {
            selection: proposal.selection, updatedAt: proposal.committedIntentUpdatedAt,
          });
          if (restored.accepted) armedSelection = null;
        } catch (error) {
          reason = 'intent_publication_failed';
          failureCause = projectSessionRuntimeFailureCause(error, 'turn_start');
        }
      }
      try {
        await clearActiveFenceUnlessPendingSuccessor();
      } catch {
        if (!isCurrent()) {
          proposal.resolve(failure(
            'owner_unavailable',
            activeTarget.selection,
            proposal.selection,
          ));
          return;
        }
        reconciliationRequired = true;
        reconciliationActiveSelection = activeTarget.selection;
        reconciliationTargets = [activeTarget];
        proposal.resolve(reconciliationFailure(
          reconciliationActiveSelection,
          proposal.selection,
          'prompt_fence_release_failed',
          applied.failureCause,
        ));
        return;
      }
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      proposal.resolve(failure(
        applied.status === 'requires_restart' ? 'restart_required' : 'apply_failed',
        activeTarget.selection,
        proposal.selection,
        reason,
        failureCause,
      ));
      return;
    }

    try {
      if (target.selection.providerConnectionId !== null || target.providerBinding !== null) {
        const authorizationStillCurrent =
          await targetAuthorizationStillCurrent(target);
        if (!isCurrent()) {
          proposal.resolve(failure(
            'owner_unavailable',
            activeTarget.selection,
            proposal.selection,
          ));
          return;
        }
        if (!authorizationStillCurrent.current) {
          throw Object.assign(new Error('provider_authorization_changed_before_publication'), { failureCause: authorizationStillCurrent.failureCause });
        }
      }
      if (runtimeObservedDriftModelId !== null) {
        throw new Error('runtime_model_drift_observed_before_publication');
      }
      if (applied.status === 'deferred') {
        await publishConfiguredTarget(target);
      } else {
        await params.publishActive(target);
      }
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      if (runtimeObservedDriftModelId !== null) {
        throw new Error('runtime_model_drift_observed_during_publication');
      }
      if (applied.status === 'applied') {
        const authorization = await targetAuthorizationStillCurrent(target);
        if (!authorization.current) {
          throw Object.assign(new Error('provider_authorization_changed_during_publication'), { failureCause: authorization.failureCause });
        }
      }
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      if (runtimeObservedDriftModelId !== null) {
        throw new Error(
          'runtime_model_drift_observed_during_publication_revalidation',
        );
      }
      activeTarget = target;
      if (applied.status === 'applied') {
        observedAppliedTarget = target;
        awaitingRuntimeConfirmation = null;
      }
      armedSelection = null;
    } catch (error) {
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      // A failed publication cannot undo the Agent's accepted configuration.
      // Keep its actual applied model; uncertain facts use the existing
      // reconciliation result and prompt fence, never a second runtime switch.
      activeTarget = target;
      if (applied.status === 'applied') {
        observedAppliedTarget = runtimeObservedDriftModelId === null ? target : null;
        awaitingRuntimeConfirmation = null;
      } else {
        awaitingRuntimeConfirmation ??= { basis: previousTarget };
      }
      armedSelection = null;
      reconciliationRequired = true;
      reconciliationActiveSelection = runtimeObservedDriftModelId !== null
        ? null
        : observedAppliedTarget?.selection ?? null;
      reconciliationTargets = runtimeObservedDriftModelId !== null ? [] : [target];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        projectSessionModelTransitionReason(
          error instanceof Error ? error.message : null,
          'active_fact_publication_failed',
        ),
        projectSessionRuntimeFailureCause(error, 'turn_start'),
      ));
      return;
    }

    if (runtimeObservedDriftModelId !== null) {
      proposal.resolve(reconciliationFailure(
        null,
        proposal.selection,
        'runtime_model_drift_observed_before_fence_release',
      ));
      return;
    }
    const promptCustody =
      await runPromptCustodyAfterSuccessfulTransition(proposal);
    if (promptCustody === 'settled') return;
    try {
      if (promptCustody === 'not_requested') {
        await clearActiveFenceUnlessPendingSuccessor();
      }
    } catch {
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      reconciliationRequired = true;
      reconciliationActiveSelection = activeTarget.selection;
      reconciliationTargets = [activeTarget];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'prompt_fence_release_failed',
      ));
      return;
    }
    if (reconciliationRequired || runtimeObservedDriftModelId !== null) {
      try {
        await ensureActiveFence();
      } catch {
        reconciliationRequired = true;
      }
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'runtime_model_drift_observed_during_fence_release',
      ));
      return;
    }
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return;
    }
    proposal.resolve(successfulProposalResult(proposal, 'applied'));
  };

  const revokeActiveSelectionProofAfterUnresolvedDrift =
    async (): Promise<void> => {
      if (!isCurrent()) return;
      try {
        await params.revokeActiveSelectionProof(activeTarget.selection);
      } catch {
        // The exact input fence stays closed when proof revocation cannot be
        // published by the current owner.
      }
    };

  const reconcileFromRuntimeReadback = async (): Promise<void> => {
    if ((awaitingRuntimeConfirmation || observedAppliedTarget === null)
      && !reconciliationRequired && params.readRuntimeModelId && isCurrent()) {
      const confirmation = awaitingRuntimeConfirmation;
      const configuredTarget = activeTarget;
      const basis = confirmation?.basis ?? configuredTarget;
      const observationRevision = runtimeObservationRevision;
      let observedModelId: string | null;
      try {
        const raw = await params.readRuntimeModelId();
        observedModelId = readNonBlankOpaqueIdentifier(raw);
      } catch {
        return;
      }
      const observationStillCurrent = (): boolean => isCurrent()
        && !reconciliationRequired
        && activeTarget === configuredTarget
        && awaitingRuntimeConfirmation === confirmation
        && (runtimeObservationRevision === observationRevision
          || latestRuntimeObservedModelId === observedModelId);
      if (!observationStillCurrent()) return;
      if (!observedModelId) {
        observedAppliedTarget = null;
        return;
      }
      if (!runtimeModelIdReadbackCanProveTarget(basis, configuredTarget)) return;
      let target: AuthorizedSessionModelTransitionTarget;
      try {
        target = observedModelId === configuredTarget.selection.modelId
          ? configuredTarget
          : await params.authorize({ ...configuredTarget.selection, modelId: observedModelId });
        if (configuredTarget.selection.providerConnectionId === null
          && target.selection.providerConnectionId === null
          && configuredTarget.readAppliedTeamCredentialModel) {
          // Model-only readback observes the current runtime, not a request
          // to replace its credential source with ordinary native auth.
          target = { ...target, readAppliedTeamCredentialModel: configuredTarget.readAppliedTeamCredentialModel };
        }
      } catch {
        return;
      }
      if (!sameSelection(target.selection, { ...configuredTarget.selection, modelId: observedModelId })
        || !runtimeModelIdReadbackCanProveTarget(basis, target)
        || !(await targetAuthorizationStillCurrent(configuredTarget)).current
        || !(await targetAuthorizationStillCurrent(target)).current
        || !observationStillCurrent()) return;
      if (observedAppliedTarget && sameAuthorizedTarget(observedAppliedTarget, target)
        && samePublishedActiveFacts(observedAppliedTarget, target)) target = observedAppliedTarget;
      try {
        await requireCurrentPublisherPermit(async () => {
          if (observationStillCurrent()) await params.publishActive(target, 'runtime_readback');
        });
        if (!(await targetAuthorizationStillCurrent(configuredTarget)).current
          || !(await targetAuthorizationStillCurrent(target)).current
          || !observationStillCurrent()) return;
        observedAppliedTarget = target;
        if (observedModelId === configuredTarget.selection.modelId) awaitingRuntimeConfirmation = null;
      } catch {
        observedAppliedTarget = null;
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        reconciliationTargets = [configuredTarget];
        try {
          await ensureActiveFence();
        } catch {
          reconciliationRequired = true;
        }
      }
      return;
    }
    if (
      !reconciliationRequired
      || !params.readRuntimeModelId
      || !isCurrent()
    ) {
      return;
    }
    let modelId: string | null;
    try {
      const rawModelId = await params.readRuntimeModelId();
      modelId = readNonBlankOpaqueIdentifier(rawModelId);
    } catch {
      if (runtimeObservedDriftModelId !== null) {
        await revokeActiveSelectionProofAfterUnresolvedDrift();
      }
      return;
    }
    if (!modelId || !isCurrent()) {
      if (runtimeObservedDriftModelId !== null) {
        await revokeActiveSelectionProofAfterUnresolvedDrift();
      }
      return;
    }

    if (runtimeObservedDriftModelId !== null) {
      // Runtime-origin drift is evidence, not permission to switch models.
      // The model catalog keeps reporting the real model; revoke stale exact
      // source proof and retain the existing explicit restart recovery.
      try {
        await ensureActiveFence();
      } catch {
        reconciliationRequired = true;
      }
      await revokeActiveSelectionProofAfterUnresolvedDrift();
      return;
    }

    if (reconciliationTargets.length === 0) return;
    const matchingTargets = reconciliationTargets.filter(
      (candidate) => candidate.selection.modelId === modelId,
    );
    if (matchingTargets.length !== 1) return;
    const target = matchingTargets[0]!;
    if (!runtimeModelIdReadbackCanProveTarget(awaitingRuntimeConfirmation?.basis ?? activeTarget, target)) return;
    if (!(await targetAuthorizationStillCurrent(target)).current) {
      return;
    }
    if (!isCurrent()) return;
    try {
      await params.publishActive(target);
      if (!isCurrent()) return;
      if (!(await targetAuthorizationStillCurrent(target)).current) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        reconciliationTargets = [];
        return;
      }
      if (!isCurrent()) return;
      activeTarget = target;
      observedAppliedTarget = target;
      awaitingRuntimeConfirmation = null;
      reconciliationActiveSelection = target.selection;
      if (runtimeObservedDriftModelId !== null) {
        reconciliationRequired = true;
        reconciliationTargets = [];
        return;
      }
      reconciliationRequired = false;
      reconciliationTargets = [];
      await clearActiveFence();
      if (!isCurrent()) return;
      if (reconciliationRequired || runtimeObservedDriftModelId !== null) {
        try {
          await ensureActiveFence();
        } catch {
          reconciliationRequired = true;
        }
      }
    } catch {
      reconciliationRequired = true;
      reconciliationActiveSelection = target.selection;
      reconciliationTargets = [target];
    }
  };

  const pump = async (): Promise<void> => {
    while (pending || readbackReconciliationRequested) {
      if (pending) {
        const proposal = pending;
        pending = null;
        current = proposal;
        await processProposal(proposal);
        expectedRuntimeEffectModelId = null;
        current = null;
        continue;
      }
      readbackReconciliationRequested = false;
      await reconcileFromRuntimeReadback();
      expectedRuntimeEffectModelId = null;
    }
  };

  const ensurePump = (): void => {
    if (pumpPromise || stableActiveTargetEffect) return;
    pumpPromise = Promise.resolve()
      .then(pump)
      .finally(() => {
        pumpPromise = null;
        if (pending || readbackReconciliationRequested) ensurePump();
      });
  };

  const runWithStableActiveTarget = async <T>(
    effect: (
      target: AuthorizedSessionModelTransitionTarget,
      runWithCurrentPublisherPermit: <U>(
        localEffect: () => Promise<U>,
      ) => Promise<
        | Readonly<{ status: 'completed'; value: U }>
        | Readonly<{ status: 'blocked'; failureCause?: SessionRuntimeIssueV1['failureCause'] }>
      >,
    ) => Promise<T>,
  ): Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked'; failureCause?: SessionRuntimeIssueV1['failureCause'] }>
  > => {
    if (
      !accepting
      || !isCurrent()
      || reconciliationRequired
      || activeFenceEpochId !== null
      || current !== null
      || pending !== null
      || pumpPromise !== null
      || stableActiveTargetEffect
    ) {
      return { status: 'blocked' };
    }
    stableActiveTargetEffect = true;
    let settleStableEffect!: () => void;
    stableActiveTargetEffectSettled = new Promise<void>((resolve) => {
      settleStableEffect = resolve;
    });
    const target = activeTarget;
    try {
      return await runWithCurrentPublisherPermit(async () => await effect(target, runWithCurrentPublisherPermit));
    } finally {
      stableActiveTargetEffect = false;
      settleStableEffect();
      stableActiveTargetEffectSettled = null;
      if (pending || readbackReconciliationRequested) ensurePump();
    }
  };

  const admitReplacementTarget = async (
    target: AuthorizedSessionModelTransitionTarget,
  ): Promise<void> => {
    if (runtimeReplacementTarget && accepting && isCurrent() && !reconciliationRequired && runtimeObservedDriftModelId === null) {
      if (!sameSelection(runtimeReplacementTarget.selection, target.selection)) {
        throw new Error('replacement_target_selection_mismatch');
      }
      // The current proposal already admitted this exact selection. Refresh
      // its opened binding facts here; publish once the runtime apply proves it.
      runtimeReplacementTarget = target;
      return;
    }
    if (
      !accepting
      || !isCurrent()
      || reconciliationRequired
      || runtimeObservedDriftModelId !== null
      || activeFenceEpochId !== null
      || current !== null
      || pending !== null
      || pumpPromise !== null
      || stableActiveTargetEffect
    ) {
      throw new Error('replacement_target_admission_unavailable');
    }
    if (!sameSelection(activeTarget.selection, target.selection)) {
      throw new Error('replacement_target_selection_mismatch');
    }
    if (samePublishedActiveFacts(activeTarget, target)) return;

    const publication = await runWithCurrentPublisherPermit(async () => {
      await publishConfiguredTarget(target);
    });
    if (publication.status === 'blocked') {
      throw Object.assign(new Error('session_publisher_authority_lost'), {
        ...(publication.failureCause ? { failureCause: publication.failureCause } : {}),
      });
    }
    if (!isCurrent()) {
      throw new Error('session_publisher_authority_lost');
    }
    activeTarget = target;
  };

  if (params.subscribeRuntimeModelChanges) {
    unsubscribeRuntimeModelChanges = params.subscribeRuntimeModelChanges((rawModelId) => {
      if (!accepting || !isCurrent()) return;
      const modelId = readNonBlankOpaqueIdentifier(rawModelId);
      latestRuntimeObservedModelId = modelId;
      runtimeObservationRevision += 1;
      if (observedAppliedTarget?.selection.modelId !== modelId) observedAppliedTarget = null;
      const matchesReconciliationTarget =
        modelId !== null
        && reconciliationRequired
        && reconciliationTargets.some(
          (candidate) => candidate.selection.modelId === modelId,
        );
      if (
        modelId
        && awaitingRuntimeConfirmation === null
        && modelId !== activeTarget.selection.modelId
        && modelId !== expectedRuntimeEffectModelId
        && !matchesReconciliationTarget
      ) {
        runtimeObservedDriftModelId = modelId;
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        reconciliationTargets = [];
      }
      readbackReconciliationRequested = true;
      ensurePump();
    });
  }

  const submit = (
    rawSelection: ProviderBoundModelRef,
    context: Readonly<{
      source: Proposal['source'];
      reuseInitialAdmission?: boolean;
      applyTiming?: 'immediate' | 'next_prompt';
      callerInputConstraints?: CallerInputConstraintsV1;
      captureBefore?: boolean;
      expected?: SessionModelMutationExpectedV1;
      runWithActiveSelection?: NonNullable<Proposal['runWithActiveSelection']>;
      restartRuntime?: SessionModelTransitionRestart;
    }>,
  ): Promise<SessionModelTransitionResultV1> => {
    const selection = ProviderBoundModelRefSchema.parse(rawSelection);
    if (context.applyTiming === 'next_prompt' && (context.captureBefore || context.expected)) {
      return Promise.resolve(failure('unsupported', activeTarget.selection, selection, 'exact_model_mutation_requires_immediate_transition'));
    }
    if (context.callerInputConstraints && !isModelRefGrantedV1(context.callerInputConstraints, selection)) {
      return Promise.resolve(failure('unsupported', activeTarget.selection, selection, 'model_not_granted'));
    }
    if (selection.agentTargetKey !== params.agentTargetKey) {
      return Promise.resolve(failure(
        'unsupported',
        activeTarget.selection,
        selection,
        'model_selection_agent_target_mismatch',
      ));
    }
    if (
      context.source === 'prompt'
      && typeof context.runWithActiveSelection !== 'function'
    ) {
      return Promise.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        selection,
        'canonical_prompt_custody_unavailable',
      ));
    }
    if (!accepting || !isCurrent()) {
      return Promise.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        selection,
      ));
    }
    if (reconciliationRequired) {
      return Promise.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        selection,
      ));
    }
    // Owner-authored intent publication can synchronously echo through the
    // metadata observer before this proposal reaches its effect boundary.
    // Coalesce exact echoes so they cannot supersede their own command.
    const runWithActiveSelection =
      context.source === 'prompt'
        ? context.runWithActiveSelection ?? null
        : null;
    const mayCoalesce = (proposal: Proposal): boolean =>
      context.source === 'metadata'
      || (
        runWithActiveSelection === null
        && proposal.runWithActiveSelection === null
        && proposal.applyTiming === context.applyTiming
        && !context.captureBefore && !context.expected
        && !proposal.captureBefore && !proposal.expected
      );
    if (
      current
      && !current.superseded
      && sameSelection(current.selection, selection)
      && mayCoalesce(current)
    ) {
      return current.promise;
    }
    if (
      pending
      && sameSelection(pending.selection, selection)
      && mayCoalesce(pending)
    ) {
      return pending.promise;
    }
    const conditionalOrCapture = context.captureBefore || context.expected;
    if (conditionalOrCapture && pending) {
      return Promise.resolve(failure('superseded', activeTarget.selection, selection, 'model_mutation_owner_busy'));
    }
    if (current && !current.effectStarted && !conditionalOrCapture) {
      current.superseded = true;
    }

    let resolve!: (result: SessionModelTransitionResultV1) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SessionModelTransitionResultV1>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    const proposal: Proposal = {
      ...(context.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
      ...(context.captureBefore ? { captureBefore: true } : {}),
      ...(context.expected ? { expected: context.expected } : {}),
      selection,
      source: context.source,
      ...(context.reuseInitialAdmission ? { reuseInitialAdmission: true } : {}),
      ...(context.applyTiming ? { applyTiming: context.applyTiming } : {}),
      runWithActiveSelection,
      ...(context.source === 'prompt' && context.restartRuntime ? { restartRuntime: context.restartRuntime } : {}),
      effectStarted: false,
      superseded: false,
      resolve: (result) => {
        if (result.ok && result.status !== 'armed' && proposal.captureBefore && proposal.capturedBefore
          && proposal.committedIntentUpdatedAt !== undefined && params.ownerScope) {
          resolve({ ...result, reversal: { owner: 'active', scope: params.ownerScope, runId: params.runId,
            before: proposal.capturedBefore, applied: result.activeSelection, updatedAt: proposal.committedIntentUpdatedAt } });
        } else resolve(result);
      },
      reject,
      promise,
    };
    replacePending(proposal);
    ensurePump();
    return promise;
  };

  const dispose = (): Promise<void> => {
    if (disposalPromise) return disposalPromise;
    accepting = false;
    unsubscribeRuntimeModelChanges?.();
    unsubscribeRuntimeModelChanges = null;
    readbackReconciliationRequested = false;
    if (pending) {
      pending.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        pending.selection,
      ));
      pending = null;
    }
    disposalPromise = (async () => {
      // The hosting run remains the current owner until every already-started
      // external effect has completed. This serializes retirement with active
      // fact publication so a replacement run cannot become authoritative
      // while an old owner still has a metadata write in flight.
      while (pumpPromise) {
        await pumpPromise;
      }
      while (stableActiveTargetEffectSettled) {
        await stableActiveTargetEffectSettled;
      }
      if (
        activeFenceEpochId
        && !reconciliationRequired
        && isCurrent()
      ) {
        try {
          await clearActiveFence();
        } catch {
          reconciliationRequired = true;
          reconciliationActiveSelection = activeTarget.selection;
        }
      }
      disposed = true;
    })();
    return disposalPromise;
  };

  return Object.freeze({
    submit,
    unarm: (callerInputConstraints?: CallerInputConstraintsV1) => submit(
      awaitingRuntimeConfirmation?.basis.selection ?? activeTarget.selection, {
      source: 'command', ...(callerInputConstraints ? { callerInputConstraints } : {}),
    }),
    admitReplacementTarget,
    readActiveTarget: () => activeTarget,
    readReplacementTarget: () => runtimeReplacementTarget ?? activeTarget,
    readArmedSelection: () => {
      if (armedSelection) return armedSelection;
      const intent = params.readModelSelectionIntent();
      if (intent?.ref.source !== 'team_resource') return null;
      const selection = { agentTargetKey: intent.ref.agentTargetKey,
        providerConnectionId: null, modelId: intent.ref.modelId };
      return sameSelection(activeTarget.selection, selection)
        && sameTeamResourceBinding(intent.ref, readTeamRoute(activeTarget)) ? null : selection;
    },
    readAppliedTarget,
    runWithStableActiveTarget,
    dispose,
  });
}
