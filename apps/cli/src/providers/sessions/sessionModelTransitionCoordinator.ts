import {
  ProviderBoundModelRefSchema,
  type ModelSelectionApplyPolicy,
  type ProviderBoundModelRef,
  type ProviderRuntimeBindingBasisV1,
  type SessionModelTransitionResultV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  isRuntimeConfigUpdateOutcomeApplied,
  type RuntimeConfigUpdateOutcomeV1,
} from '@happier-dev/agents';

export type AuthorizedSessionModelTransitionTarget = Readonly<{
  selection: ProviderBoundModelRef;
  policy: ModelSelectionApplyPolicy;
  providerBinding: AgentSessionProviderBinding | null;
  sessionBindingMetadata: SessionProviderBindingMetadataV1 | null;
  runtimeBindingBasis: ProviderRuntimeBindingBasisV1 | null;
  revalidateBeforeEffect: () => Promise<boolean>;
}>;

export type SessionModelTransitionApplyResult =
  | Readonly<{ status: 'applied' }>
  | Readonly<{
      status: 'failed' | 'unsupported' | 'unproven';
      reason?: string;
      readbackAfterCompletion?: boolean;
    }>;

export function mapRuntimeConfigUpdateOutcomeToSessionModelTransitionApplyResult(
  outcome: RuntimeConfigUpdateOutcomeV1 | void | null,
): SessionModelTransitionApplyResult {
  if (outcome === undefined || outcome === null) {
    return {
      status: 'unproven',
      reason: 'runtime_model_transition_outcome_unproven',
      readbackAfterCompletion: true,
    };
  }
  if (isRuntimeConfigUpdateOutcomeApplied(outcome)) {
    return { status: 'applied' };
  }
  return {
    status: outcome.status === 'unsupported' ? 'unsupported' : 'failed',
    reason: outcome.reason ?? 'runtime_model_transition_not_applied',
  };
}

type Proposal = {
  selection: ProviderBoundModelRef;
  source: 'command' | 'metadata' | 'prompt';
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

function sameAuthorizedTarget(
  left: AuthorizedSessionModelTransitionTarget,
  right: AuthorizedSessionModelTransitionTarget,
): boolean {
  if (!sameSelection(left.selection, right.selection)) return false;
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
  }) === JSON.stringify({
    providerBinding: right.providerBinding,
    sessionBindingMetadata: right.sessionBindingMetadata,
    runtimeBindingBasis: right.runtimeBindingBasis,
  });
}

function runtimeModelIdReadbackCanProveTarget(
  current: AuthorizedSessionModelTransitionTarget,
  candidate: AuthorizedSessionModelTransitionTarget,
): boolean {
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
        connectionId: target.providerBinding.connectionId,
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
): Extract<SessionModelTransitionResultV1, { ok: false }> {
  return {
    ok: false,
    status,
    activeSelection,
    requestedSelection,
    ...(reason ? { reason } : {}),
  };
}

function reconciliationFailure(
  activeSelection: ProviderBoundModelRef | null,
  requestedSelection: ProviderBoundModelRef,
  reason?: string,
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
  initialActiveTarget: AuthorizedSessionModelTransitionTarget;
  isCurrentRun: () => boolean;
  checkCurrentPublisherAuthority: () => Promise<boolean>;
  authorize: (
    selection: ProviderBoundModelRef,
  ) => Promise<AuthorizedSessionModelTransitionTarget>;
  publishIntent: (
    selection: ProviderBoundModelRef,
  ) => Promise<Readonly<{ accepted: boolean; updatedAt: number }>>;
  applyRuntime: (
    target: AuthorizedSessionModelTransitionTarget,
  ) => Promise<SessionModelTransitionApplyResult>;
  publishActive: (
    target: AuthorizedSessionModelTransitionTarget,
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
      runWithActiveSelection?: NonNullable<Proposal['runWithActiveSelection']>;
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
  runWithStableActiveTarget: <T>(
    effect: (
      target: AuthorizedSessionModelTransitionTarget,
      runWithCurrentPublisherPermit: <U>(
        localEffect: () => Promise<U>,
      ) => Promise<
        | Readonly<{ status: 'completed'; value: U }>
        | Readonly<{ status: 'blocked' }>
      >,
    ) => Promise<T>,
  ) => Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked' }>
  >;
  dispose: () => Promise<void>;
}> {
  let activeTarget = params.initialActiveTarget;
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

  const isCurrent = (): boolean =>
    !disposed
    && !publisherAuthorityUnavailable
    && params.isCurrentRun();

  const runWithCurrentPublisherPermit = async <T>(
    localEffect: () => Promise<T>,
  ): Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked' }>
  > => {
    if (!isCurrent()) return { status: 'blocked' };
    const current = await params.checkCurrentPublisherAuthority()
      .catch(() => false);
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
      throw new Error('session_publisher_authority_lost');
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
        reason: error instanceof Error ? error.message : 'runtime_apply_failed',
        readbackAfterCompletion: true,
      };
    }
  };

  const targetAuthorizationStillCurrent = async (
    target: AuthorizedSessionModelTransitionTarget,
  ): Promise<boolean> => {
    if (target.selection.providerConnectionId === null) return true;
    if (typeof target.revalidateBeforeEffect !== 'function') return false;
    return await target.revalidateBeforeEffect().catch(() => false);
  };

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
        error instanceof Error ? error.message : 'prompt_fence_failed',
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
            throw new Error('session_publisher_authority_lost');
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
  ): Promise<boolean> => {
    if (!params.readRuntimeModelId) return false;
    const settleContradictoryReadback = async (
      reason: string,
    ): Promise<boolean> => {
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
      ));
      return true;
    };
    const readbackObservationRevision = runtimeObservationRevision;
    let modelId: string | null;
    try {
      const rawModelId = await params.readRuntimeModelId();
      modelId = typeof rawModelId === 'string' && rawModelId.trim().length > 0
        ? rawModelId.trim()
        : null;
    } catch {
      return false;
    }
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return true;
    }
    if (modelId !== target.selection.modelId) return false;
    if (!runtimeModelIdReadbackCanProveTarget(activeTarget, target)) {
      return false;
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
    if (!await targetAuthorizationStillCurrent(target)) {
      return false;
    }
    if (!isCurrent()) {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
      ));
      return true;
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
      await params.publishActive(target);
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return true;
      }
      if (runtimeObservedDriftModelId !== null || reconciliationRequired) {
        return await settleContradictoryReadback(
          'runtime_model_drift_observed_during_readback_publication',
        );
      }
      if (!await targetAuthorizationStillCurrent(target)) {
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
        return true;
      }
      if (runtimeObservedDriftModelId !== null || reconciliationRequired) {
        return await settleContradictoryReadback(
          'runtime_model_drift_observed_during_readback_publication_revalidation',
        );
      }
      activeTarget = target;
      const promptCustody =
        await runPromptCustodyAfterSuccessfulTransition(proposal);
      if (promptCustody === 'settled') return true;
      if (promptCustody === 'not_requested') {
        await clearActiveFenceUnlessPendingSuccessor();
      }
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return true;
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
      return true;
    } catch {
      reconciliationRequired = true;
      reconciliationActiveSelection = target.selection;
      reconciliationTargets = [target];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        'runtime_readback_publication_failed',
      ));
      return true;
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
    let target: AuthorizedSessionModelTransitionTarget;
    try {
      target = await params.authorize(proposal.selection);
    } catch (error) {
      if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
      await settleBeforeRuntimeEffect(proposal, failure(
        'unsupported',
        activeTarget.selection,
        proposal.selection,
        error instanceof Error ? error.message : 'model_transition_authorization_failed',
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

    // Metadata proposals are observations of an intent that already won the
    // durable CAS. Republishing them would mint a newer timestamp and feed the
    // metadata synchronizer back into this coordinator indefinitely.
    if (proposal.source !== 'metadata') {
      // A durable CAS that has started must finish, but it is not the runtime
      // effect boundary. A newer proposal may still supersede this one; the
      // newer CAS runs afterward so accepted intent order remains preserved.
      try {
        const publication = await params.publishIntent(proposal.selection);
        if (!publication.accepted) {
          await settleBeforeRuntimeEffect(proposal, failure(
            'superseded',
            activeTarget.selection,
            proposal.selection,
            'accepted_intent_was_superseded',
          ));
          return;
        }
      } catch (error) {
        if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
        await settleBeforeRuntimeEffect(proposal, failure(
          'apply_failed',
          activeTarget.selection,
          proposal.selection,
          error instanceof Error ? error.message : 'intent_publication_failed',
        ));
        return;
      }
    }
    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
    if (pending) {
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
      sameAuthorizedTarget(activeTarget, target)
      && samePublishedActiveFacts(activeTarget, target)
    ) {
      const promptCustody =
        await runPromptCustodyAfterSuccessfulTransition(proposal);
      if (promptCustody === 'settled') return;
      if (promptCustody === 'completed') {
        proposal.resolve({
          ok: true,
          status: 'already_active',
          activeSelection: activeTarget.selection,
        });
        return;
      }
      await settleBeforeRuntimeEffect(proposal, {
        ok: true,
        status: 'already_active',
        activeSelection: activeTarget.selection,
      });
      return;
    }

    if (target.policy === 'restart_session') {
      await settleBeforeRuntimeEffect(proposal, failure(
        'restart_required',
        activeTarget.selection,
        proposal.selection,
      ));
      return;
    }

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
          error instanceof Error ? error.message : 'prompt_fence_failed',
        ));
        return;
      }
    }
    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;

    if (target.selection.providerConnectionId !== null) {
      const authorizationStillCurrent =
        await targetAuthorizationStillCurrent(target);
      if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
      if (!authorizationStillCurrent) {
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
        ));
        return;
      }
    }

    if (await settleIfInterruptedBeforeRuntimeEffect(proposal)) return;
    let forwardEffectObservationRevision = runtimeObservationRevision;
    const permittedApply = await runWithCurrentPublisherPermit(async () => {
      // This immediate invocation is the runtime-effect boundary. From this
      // synchronous point onward, the operation must reconcile the effect it
      // may have caused.
      proposal.effectStarted = true;
      forwardEffectObservationRevision = runtimeObservationRevision;
      expectedRuntimeEffectModelId = target.selection.modelId;
      return await safelyApply(target);
    });
    if (permittedApply.status === 'blocked') {
      proposal.resolve(failure(
        'owner_unavailable',
        activeTarget.selection,
        proposal.selection,
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
      applied.status !== 'applied'
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
      ));
      return;
    }
    if (runtimeObservedDriftModelId !== null) {
      proposal.resolve(reconciliationFailure(
        null,
        proposal.selection,
        'runtime_model_drift_observed_during_transition',
      ));
      return;
    }
    if (applied.status === 'unproven') {
      if (
        applied.readbackAfterCompletion === true
        && await recoverAppliedTargetFromRuntimeReadback(proposal, target)
      ) {
        return;
      }
      reconciliationRequired = true;
      reconciliationActiveSelection = null;
      reconciliationTargets = [target];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        applied.reason ?? 'runtime_model_transition_outcome_unproven',
      ));
      return;
    }
    if (applied.status !== 'applied') {
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
        applied.reason,
      ));
      return;
    }

    try {
      if (target.selection.providerConnectionId !== null) {
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
        if (!authorizationStillCurrent) {
          throw new Error('provider_authorization_changed_before_publication');
        }
      }
      if (runtimeObservedDriftModelId !== null) {
        throw new Error('runtime_model_drift_observed_before_publication');
      }
      await params.publishActive(target);
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
      if (!await targetAuthorizationStillCurrent(target)) {
        throw new Error('provider_authorization_changed_during_publication');
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
    } catch (error) {
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      if (!await targetAuthorizationStillCurrent(previousTarget)) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        reconciliationTargets = [target];
        proposal.resolve(reconciliationFailure(
          null,
          proposal.selection,
          'provider_authorization_changed_before_rollback',
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
      const permittedRollback =
        await runWithCurrentPublisherPermit(async () => {
          expectedRuntimeEffectModelId = previousTarget.selection.modelId;
          return await safelyApply(previousTarget);
        });
      if (permittedRollback.status === 'blocked') {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      const rollback = permittedRollback.value;
      if (!isCurrent()) {
        proposal.resolve(failure(
          'owner_unavailable',
          activeTarget.selection,
          proposal.selection,
        ));
        return;
      }
      if (rollback.status === 'applied') {
        const rollbackConfirmationObservationRevision =
          runtimeObservationRevision;
        let confirmedRollbackModelId: string | null = null;
        try {
          if (!params.readRuntimeModelId) {
            throw new Error('runtime_rollback_readback_unavailable');
          }
          const rawConfirmedRollbackModelId =
            await params.readRuntimeModelId();
          confirmedRollbackModelId =
            typeof rawConfirmedRollbackModelId === 'string'
            && rawConfirmedRollbackModelId.trim().length > 0
              ? rawConfirmedRollbackModelId.trim()
              : null;
        } catch {
          reconciliationRequired = true;
          reconciliationActiveSelection = null;
          reconciliationTargets = [target, previousTarget];
          proposal.resolve(reconciliationFailure(
            null,
            proposal.selection,
            'runtime_rollback_readback_unavailable',
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
        if (
          runtimeObservedDriftModelId !== null
          || (
            runtimeObservationRevision
              !== rollbackConfirmationObservationRevision
            && latestRuntimeObservedModelId
              !== previousTarget.selection.modelId
          )
        ) {
          reconciliationRequired = true;
          reconciliationActiveSelection = null;
          reconciliationTargets = [];
          proposal.resolve(reconciliationFailure(
            null,
            proposal.selection,
            'runtime_model_drift_observed_during_rollback',
          ));
          return;
        }
        if (
          confirmedRollbackModelId !== previousTarget.selection.modelId
        ) {
          reconciliationRequired = true;
          reconciliationActiveSelection = null;
          reconciliationTargets = [target, previousTarget];
          proposal.resolve(reconciliationFailure(
            null,
            proposal.selection,
            'runtime_rollback_readback_mismatch',
          ));
          return;
        }
        if (!await targetAuthorizationStillCurrent(previousTarget)) {
          reconciliationRequired = true;
          reconciliationActiveSelection = null;
          reconciliationTargets = [];
          proposal.resolve(reconciliationFailure(
            null,
            proposal.selection,
            'provider_authorization_changed_after_rollback',
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
        if (runtimeObservedDriftModelId !== null) {
          reconciliationRequired = true;
          reconciliationActiveSelection = null;
          reconciliationTargets = [];
          proposal.resolve(reconciliationFailure(
            null,
            proposal.selection,
            'runtime_model_drift_observed_during_rollback_revalidation',
          ));
          return;
        }
        try {
          await params.publishActive(previousTarget);
          if (!isCurrent()) {
            proposal.resolve(failure(
              'owner_unavailable',
              activeTarget.selection,
              proposal.selection,
            ));
            return;
          }
          if (runtimeObservedDriftModelId !== null) {
            reconciliationRequired = true;
            reconciliationActiveSelection = previousTarget.selection;
            reconciliationTargets = [];
            proposal.resolve(reconciliationFailure(
              reconciliationActiveSelection,
              proposal.selection,
              'runtime_model_drift_observed_during_transition',
            ));
            return;
          }
          if (!await targetAuthorizationStillCurrent(previousTarget)) {
            reconciliationRequired = true;
            reconciliationActiveSelection = null;
            reconciliationTargets = [];
            proposal.resolve(reconciliationFailure(
              null,
              proposal.selection,
              'provider_authorization_changed_during_rollback_publication',
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
          if (runtimeObservedDriftModelId !== null) {
            reconciliationRequired = true;
            reconciliationActiveSelection = null;
            reconciliationTargets = [];
            proposal.resolve(reconciliationFailure(
              null,
              proposal.selection,
              'runtime_model_drift_observed_during_rollback_revalidation',
            ));
            return;
          }
          await clearActiveFenceUnlessPendingSuccessor();
          if (!isCurrent()) {
            proposal.resolve(failure(
              'owner_unavailable',
              activeTarget.selection,
              proposal.selection,
            ));
            return;
          }
          proposal.resolve(failure(
            'publication_failed_rolled_back',
            previousTarget.selection,
            proposal.selection,
            error instanceof Error ? error.message : 'active_fact_publication_failed',
          ));
          return;
        } catch {
          if (!isCurrent()) {
            proposal.resolve(failure(
              'owner_unavailable',
              activeTarget.selection,
              proposal.selection,
            ));
            return;
          }
          // The runtime is old again, but publication/fence reconciliation is
          // still uncertain. Keep the exact admission fence closed.
        }
      }
      reconciliationRequired = true;
      reconciliationActiveSelection = rollback.status === 'applied'
        ? previousTarget.selection
        : null;
      reconciliationTargets = rollback.status === 'applied'
        ? [previousTarget]
        : [target, previousTarget];
      proposal.resolve(reconciliationFailure(
        reconciliationActiveSelection,
        proposal.selection,
        rollback.status === 'applied'
          ? 'rollback_publication_failed'
          : rollback.reason ?? 'runtime_rollback_failed',
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
    proposal.resolve({
      ok: true,
      status: 'applied',
      activeSelection: activeTarget.selection,
    });
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
      modelId = typeof rawModelId === 'string' && rawModelId.trim().length > 0
        ? rawModelId.trim()
        : null;
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
      if (!activeFenceEpochId) {
        const epochId =
          `model-transition:${params.runId}:${++transitionOrdinal}`;
        try {
          await params.fencePromptAdmission(epochId);
          if (!isCurrent()) return;
          activeFenceEpochId = epochId;
        } catch {
          reconciliationRequired = true;
          reconciliationActiveSelection = null;
          await revokeActiveSelectionProofAfterUnresolvedDrift();
          return;
        }
      }

      let restorationTarget: AuthorizedSessionModelTransitionTarget;
      try {
        restorationTarget = await params.authorize(activeTarget.selection);
      } catch {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      if (
        !sameSelection(restorationTarget.selection, activeTarget.selection)
        || restorationTarget.policy !== 'live'
        || !await targetAuthorizationStillCurrent(restorationTarget)
        || !isCurrent()
      ) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      const permittedRestoration =
        await runWithCurrentPublisherPermit(async () => {
          expectedRuntimeEffectModelId =
            restorationTarget.selection.modelId;
          return await safelyApply(restorationTarget);
        });
      if (permittedRestoration.status === 'blocked') {
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      const restorationOutcome = permittedRestoration.value;
      if (restorationOutcome.status !== 'applied' || !isCurrent()) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      if (!await targetAuthorizationStillCurrent(restorationTarget)) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        reconciliationTargets = [];
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      if (!isCurrent()) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      const confirmationObservationRevision = runtimeObservationRevision;
      let confirmedModelId: string | null;
      try {
        const rawConfirmedModelId = await params.readRuntimeModelId();
        confirmedModelId =
          typeof rawConfirmedModelId === 'string'
          && rawConfirmedModelId.trim().length > 0
            ? rawConfirmedModelId.trim()
            : null;
      } catch {
        confirmedModelId = null;
      }
      if (
        confirmedModelId !== restorationTarget.selection.modelId
        || !isCurrent()
      ) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        if (confirmedModelId) {
          runtimeObservedDriftModelId = confirmedModelId;
        }
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      if (
        runtimeObservationRevision !== confirmationObservationRevision
        && latestRuntimeObservedModelId !== confirmedModelId
      ) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      if (!await targetAuthorizationStillCurrent(restorationTarget)) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        reconciliationTargets = [];
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      if (!isCurrent()) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      if (
        runtimeObservationRevision !== confirmationObservationRevision
        && latestRuntimeObservedModelId !== confirmedModelId
      ) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        await revokeActiveSelectionProofAfterUnresolvedDrift();
        return;
      }
      runtimeObservedDriftModelId = null;
      try {
        await params.publishActive(restorationTarget);
        if (!isCurrent()) return;
        if (!await targetAuthorizationStillCurrent(restorationTarget)) {
          reconciliationRequired = true;
          reconciliationActiveSelection = null;
          reconciliationTargets = [];
          return;
        }
        if (!isCurrent()) return;
        activeTarget = restorationTarget;
        reconciliationActiveSelection = restorationTarget.selection;
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
          return;
        }
      } catch {
        reconciliationRequired = true;
        reconciliationActiveSelection = restorationTarget.selection;
        reconciliationTargets = [restorationTarget];
      }
      return;
    }

    if (reconciliationTargets.length === 0) return;
    const matchingTargets = reconciliationTargets.filter(
      (candidate) => candidate.selection.modelId === modelId,
    );
    if (matchingTargets.length !== 1) return;
    const target = matchingTargets[0]!;
    if (!runtimeModelIdReadbackCanProveTarget(activeTarget, target)) return;
    if (!await targetAuthorizationStillCurrent(target)) {
      return;
    }
    if (!isCurrent()) return;
    try {
      await params.publishActive(target);
      if (!isCurrent()) return;
      if (!await targetAuthorizationStillCurrent(target)) {
        reconciliationRequired = true;
        reconciliationActiveSelection = null;
        reconciliationTargets = [];
        return;
      }
      if (!isCurrent()) return;
      activeTarget = target;
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
        | Readonly<{ status: 'blocked' }>
      >,
    ) => Promise<T>,
  ): Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked' }>
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
      const current = await params.checkCurrentPublisherAuthority()
        .catch(() => false);
      if (!current || !isCurrent()) {
        publisherAuthorityUnavailable = true;
        return { status: 'blocked' };
      }
      return {
        status: 'completed',
        value: await effect(target, runWithCurrentPublisherPermit),
      };
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
      await params.publishActive(target);
    });
    if (publication.status === 'blocked') {
      throw new Error('session_publisher_authority_lost');
    }
    if (!isCurrent()) {
      throw new Error('session_publisher_authority_lost');
    }
    activeTarget = target;
  };

  if (params.subscribeRuntimeModelChanges) {
    unsubscribeRuntimeModelChanges = params.subscribeRuntimeModelChanges((rawModelId) => {
      if (!accepting || !isCurrent()) return;
      const modelId =
        typeof rawModelId === 'string' && rawModelId.trim().length > 0
          ? rawModelId.trim()
          : null;
      if (modelId) {
        latestRuntimeObservedModelId = modelId;
        runtimeObservationRevision += 1;
      }
      const matchesReconciliationTarget =
        modelId !== null
        && reconciliationRequired
        && reconciliationTargets.some(
          (candidate) => candidate.selection.modelId === modelId,
        );
      if (
        modelId
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
      runWithActiveSelection?: NonNullable<Proposal['runWithActiveSelection']>;
    }>,
  ): Promise<SessionModelTransitionResultV1> => {
    const selection = ProviderBoundModelRefSchema.parse(rawSelection);
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
    if (current && !current.effectStarted) {
      current.superseded = true;
    }

    let resolve!: (result: SessionModelTransitionResultV1) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SessionModelTransitionResultV1>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    const proposal: Proposal = {
      selection,
      source: context.source,
      runWithActiveSelection,
      effectStarted: false,
      superseded: false,
      resolve,
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
    admitReplacementTarget,
    readActiveTarget: () => activeTarget,
    runWithStableActiveTarget,
    dispose,
  });
}
