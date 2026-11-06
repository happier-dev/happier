import { MachineStorageDockerPruneResultV1Schema } from '@happier-dev/protocol';
import { MachineServiceAdoptResultV1Schema } from '@happier-dev/protocol/local/services/adoptionV1';
import { randomUUID } from 'node:crypto';

import type {
  ActionOperationCancelV1Response,
  ActionExecuteResult,
} from '@happier-dev/protocol/actions';
import { ActionOperationDomainRefV1Schema, ActionOperationFailureV1Schema, ActionOperationObservationV1Schema,
  canRetainProjectSetupReviewV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { ProjectPrepareNoLaunchResultV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { normalizeSessionCreationSelectionIdentityV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ProjectServiceRelocateInputV1, ProjectServiceMoveStartClaimResultV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';

import { MachineRebootResultV1Schema } from '@happier-dev/protocol';

import { projectActionOperationFailure } from './actionOperationFailure';
import { parseActionOperationProgressUpdate } from './actionOperationProgress';
import { createActionOperationSetupReview } from './actionOperationSetupReview';
import { settleReviewedIsolationPredecessors } from './settleReviewedIsolationPredecessors';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { ActionOperationStore } from './actionOperationStore';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import type {
  ActionOperationOwnerUpdate,
  ActionOperationProgressUpdate,
  ActionOperationQueryScope,
  ActionOperationScope,
  ResolvedTrackedAction,
  ActionOperationReviewContinuation,
  ActionOperationSetupDecision,
} from './actionOperationTypes';

type ActiveInvocation = Readonly<{
  actionId: string;
  scope: ActionOperationScope;
  controller: AbortController;
  cancellation: 'unsupported' | 'supported';
  result: Promise<ActionExecuteResult>;
  response: Promise<ActionExecuteResult>;
  notifyCancellationRequested: () => void;
  resumeSetupReview: () => void;
  refreshSetupReview: () => Promise<void>;
  decideSetupReview: (decision: ActionOperationSetupDecision) => Promise<void>;
  serviceMoveStart?: { claimed: boolean };
}>;

function terminalResult(snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): ActionExecuteResult | null {
  const metadata = snapshot.operationCredentialUses ? { operationCredentialUses: snapshot.operationCredentialUses } : {};
  if (snapshot.state === 'succeeded') return { ok: true, result: snapshot.result, ...metadata };
  if (snapshot.state === 'failed') {
    return {
      ok: false,
      errorCode: snapshot.error?.errorCode ?? 'action_operation_failed',
      error: snapshot.error?.error ?? 'action_operation_failed',
      ...(snapshot.error?.failureCause ? { failureCause: snapshot.error.failureCause } : {}),
      ...(snapshot.error?.details ? { details: snapshot.error.details } : {}),
      ...metadata,
    };
  }
  if (snapshot.state === 'cancelled') return { ok: false, errorCode: 'cancelled', error: 'cancelled', ...metadata };
  return null;
}

function createCancellationRequestError(): Error {
  const error = new Error('Action operation cancellation requested');
  error.name = 'AbortError';
  return error;
}

function isRecoverableIndeterminateHandoff(
  actionId: string,
  result: ActionExecuteResult,
): boolean {
  return actionId === 'session.handoff'
    && !result.ok
    && result.errorCode === 'indeterminate';
}

function isFiniteProjectCommand(actionId: string): boolean {
  return actionId === 'projects.script.run' || actionId === 'projects.compute.exec' || actionId === 'projects.prepare';
}

function isUnconfirmedNativeOutcome(actionId: string, result: ActionExecuteResult | undefined): result is Extract<ActionExecuteResult, { ok: false }> {
  return !!result && !result.ok && (result.errorCode === 'indeterminate'
    || (actionId === 'machines.services.control' || actionId === 'machines.services.exec' || actionId === 'machines.reboot'
      || actionId === 'machines.storage.docker.prune') && result.errorCode === 'action_outcome_unknown'
    || actionId === 'machines.agentIsolation.set' && result.errorCode === 'outcome_unknown');
}

function isUnconfirmedOwnedOutcome(actionId: string, result: ActionExecuteResult): boolean {
  // These native owners explicitly could not verify physical process exit.
  if (!result.ok && (result.errorCode === 'plugin_exec_termination_incomplete'
    || result.errorCode === 'native_toolchain_termination_incomplete')) return true;
  if (actionId === 'machines.reboot') return !result.ok && result.errorCode === 'action_outcome_unknown';
  if (actionId === 'machines.managed.power.set' || actionId === 'machines.managed.delete' || actionId === 'machines.managed.rebuild'
    || actionId === 'machines.managed.acquire' || actionId === 'machines.managed.bootstrap.retry'
    || actionId === 'machines.storage.docker.prune') {
    return !result.ok && result.errorCode === 'action_outcome_unknown';
  }
  if (actionId === 'daemon.filesystem.upload' || actionId === 'daemon.filesystem.download' || actionId === 'daemon.filesystem.copy') {
    return !result.ok && result.errorCode === 'indeterminate';
  }
  return (isFiniteProjectCommand(actionId) || actionId === 'projects.service.relocate' || actionId === 'localServices.launcher.start' || actionId === 'deployments.publish' || actionId === 'machines.environment.apply') && !result.ok
    && (result.errorCode === 'outcome_uncertain' || result.errorCode === 'stop_unconfirmed');
}

export function createActionOperationRunner(deps: Readonly<{
  store: ActionOperationStore;
  resolveAction: (actionId: string) => ResolvedTrackedAction | null;
  generateOperationId?: () => string;
  publishSnapshotAcknowledged?: (snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1) => Promise<boolean>;
}>) {
  const generateOperationId = deps.generateOperationId ?? randomUUID;
  const active = new Map<string, ActiveInvocation>();
  let finiteRetirement: Promise<void> | undefined;

  const observe = async (request: Readonly<{
    actionId: string;
    action?: ResolvedTrackedAction;
    requestId?: string;
    input?: unknown;
    domainRef?: import('@happier-dev/protocol/actions').ActionOperationDomainRefV1;
    scope: ActionOperationScope;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    cancellation?: 'unsupported' | 'supported';
    /** Report the canonical receipt even when an exact request rejoins a settled operation. */
    onOperation?: (operation: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1) => void;
    execute: (context: Readonly<{
      actionRequestId?: string;
      resumeActionRequest?: true;
      signal: AbortSignal;
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      updateProgress: (update: ActionOperationProgressUpdate) => void;
      publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
      operationAcceptance?: import('@happier-dev/protocol').ActionExecutorContext['operationAcceptance'];
      onCancellationRequested: (listener: () => void) => () => void;
      operationReview: ActionOperationReviewContinuation;
      afterTerminalSuccessAcknowledged?: (effect: () => Promise<void>) => void;
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const action = request.action ?? deps.resolveAction(request.actionId);
    if (!action?.operation) {
      return await request.execute({
        signal: new AbortController().signal,
        updateProgress: () => undefined,
        publishOwnerUpdate: () => undefined,
        onCancellationRequested: () => () => undefined,
        operationReview: { waitForResume: async () => { throw new Error('action_operation_unavailable'); } },
      });
    }
    const existing = request.requestId
      ? deps.store.findByRequestIdentity(request.scope, request.actionId, request.requestId)
      : null;
    const spawnInput = request.actionId === 'session.spawn_new' ? SessionSpawnNewInputV2Schema.safeParse(request.input) : null;
    const inputIdentity = createCanonicalJsonSigningInput(spawnInput?.success
      ? { ...spawnInput.data, ...normalizeSessionCreationSelectionIdentityV1(spawnInput.data) }
      : request.input === undefined ? null : request.input);
    if (existing && !deps.store.hasMatchingInputIdentity(existing.operationId, inputIdentity)) {
      return await timeWebLatencyPhase('action.operation.input_conflict', () => ({
        ok: false as const, errorCode: 'action_request_input_conflict', error: 'action_request_input_conflict',
      }), undefined, () => ({ operationId: existing.operationId,
        ...(request.requestId ? { executionRequestId: request.requestId } : {}), inputIdentityEqual: false }));
    }
    const previousCreation = action.actionId === 'session.spawn_new' && existing?.state === 'succeeded'
      ? SessionSpawnNewResultV1Schema.safeParse(existing.result) : null;
    const previousSessionCreationFailure = previousCreation?.success && previousCreation.data.type === 'error'
      && previousCreation.data.retryable ? previousCreation.data : undefined;
    const invoke = async (
      operationId: string,
      cancellation: 'unsupported' | 'supported',
      resumeActionRequest = false,
    ): Promise<ActionExecuteResult> => {
      const controller = new AbortController();
      const retainedReview = createActionOperationSetupReview({ signal: controller.signal,
        publish: details => { deps.store.updateSetupReview(operationId, details); } });
      const operationReview: ActionOperationReviewContinuation = {
        waitForResume: (details, producer) => {
          if (!canRetainProjectSetupReviewV1(action.actionId)) return Promise.reject(new Error('action_operation_unavailable'));
          return retainedReview.operationReview.waitForResume(details, producer);
        },
      };
      const cancellationListeners = new Set<() => void>();
      const ownerEvidence: { outcome?: ActionExecuteResult } = {};
      let lastEffect: (() => Promise<void>) | undefined;
      let terminalSuccess: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null = null;
      const onCancellationRequested = (listener: () => void): (() => void) => {
        cancellationListeners.add(listener);
        return () => { cancellationListeners.delete(listener); };
      };
      let accept!: (result: ActionExecuteResult) => void;
      const acceptance = new Promise<ActionExecuteResult>((resolve) => { accept = resolve; });
      const acceptFinite = (): void => {
        const operation = deps.store.get(request.scope, operationId);
        if (operation?.domainRef?.kind === 'projectCommand') accept({ ok: true, result: { operation } });
      };
      const updateProgress = (update: ActionOperationProgressUpdate): void => {
        const progress = parseActionOperationProgressUpdate(update);
        if (progress) {
          deps.store.updateProgress(operationId, progress);
          if (action.actionId === 'projects.service.relocate' && progress.kind === 'phase' && progress.phase === 'stopping') {
            const operation = deps.store.get(request.scope, operationId);
            if (operation) accept({ ok: true, result: { status: 'accepted', operation } });
          }
        }
      };
      const publishOwnerUpdate = (update: ActionOperationOwnerUpdate): void => {
        if (update.cancellation !== undefined) {
          cancellation = update.cancellation;
          deps.store.updateCancellation(operationId, cancellation);
        }
        if (update.outcome !== undefined) ownerEvidence.outcome = update.outcome;
        if (update.domainRef) {
          const domainRef = ActionOperationDomainRefV1Schema.safeParse(update.domainRef);
          if (domainRef.success) deps.store.updateDomainRef(operationId, domainRef.data);
          if (domainRef.success && domainRef.data.kind === 'projectCommand' && isFiniteProjectCommand(action.actionId)) {
            acceptFinite();
          }
        }
        if (update.state === 'running') deps.store.markRunning(operationId);
        if (update.observation === null) deps.store.updateObservation(operationId, null);
        else if (update.observation) {
          const observation = ActionOperationObservationV1Schema.safeParse(update.observation);
          if (observation.success) deps.store.updateObservation(operationId, observation.data);
        }
        if (update.progress) updateProgress(update.progress);
      };
      const result = Promise.resolve().then(async (): Promise<ActionExecuteResult> => {
        try {
          const attribution = deps.store.readRequesterWorkAttribution(operationId);
          const handlerResult = await request.execute({
            ...(attribution ? { requesterWorkAttributionV1: attribution } : {}),
            actionRequestId: request.requestId ?? operationId,
            ...(resumeActionRequest ? { resumeActionRequest: true as const } : {}),
            signal: controller.signal,
            updateProgress,
            publishOwnerUpdate,
            onCancellationRequested,
            operationReview,
            afterTerminalSuccessAcknowledged: effect => {
              lastEffect = effect;
            },
            operationAcceptance: { operationId, actionId: action.actionId,
              ...(previousSessionCreationFailure ? { previousSessionCreationFailure } : {}), accept: (result) => {
              if (isFiniteProjectCommand(action.actionId)) acceptFinite();
              else accept({ ok: true, result });
            } },
          });
          // Only the private native owner supplies effect evidence. Valid plugin
          // JSON is not a success receipt, and native completion cannot erase a
          // failure in the handler's later admitted work.
          const nativeOutcome = ownerEvidence.outcome;
          if (handlerResult.operationCredentialUses) {
            deps.store.updateCredentialUses(operationId, handlerResult.operationCredentialUses);
          }
          const executionResult = !handlerResult.ok ? handlerResult
            : nativeOutcome && !nativeOutcome.ok ? {
              ...nativeOutcome,
              ...(handlerResult.operationCredentialUses ? { operationCredentialUses: handlerResult.operationCredentialUses } : {}),
            } : handlerResult;
          if (isUnconfirmedNativeOutcome(action.actionId, nativeOutcome)) {
            // A later handler failure is still returned intact, but cannot
            // turn an unconfirmed physical effect into known terminal evidence.
            deps.store.updateObservation(operationId, { kind: 'outcome_uncertain',
              code: handlerResult.ok ? nativeOutcome.errorCode : handlerResult.errorCode });
            const pruneReceipt = action.actionId === 'machines.storage.docker.prune' && handlerResult.ok
              ? MachineStorageDockerPruneResultV1Schema.safeParse(handlerResult.result) : null;
            if (pruneReceipt?.success && pruneReceipt.data.kind === 'outcome_unknown') return handlerResult;
            const rebootReceipt = action.actionId === 'machines.reboot' && handlerResult.ok
              ? MachineRebootResultV1Schema.safeParse(handlerResult.result) : null;
            if (rebootReceipt?.success && rebootReceipt.data.kind === 'accepted'
              && rebootReceipt.data.operation.operationId === operationId) return handlerResult;
            return executionResult;
          }
          if (isRecoverableIndeterminateHandoff(action.actionId, executionResult)) {
            return executionResult;
          }
          if (action.actionId === 'machines.reboot' && executionResult.ok) {
            const receipt = MachineRebootResultV1Schema.safeParse(executionResult.result);
            if (receipt.success && receipt.data.kind === 'accepted') {
              deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: 'action_outcome_unknown' });
              if (receipt.data.operation.operationId !== operationId) return { ok: false,
                errorCode: 'action_outcome_unknown', error: 'Reboot dispatch could not be correlated with this operation' };
              return executionResult;
            }
            if (receipt.success && receipt.data.kind !== 'accepted') {
              // A typed refusal is not physical success simply because the
              // transport/domain envelope was parsed successfully. Retain the
              // exact receipt at the SAME operation owner for its consumers.
              const errorCode = receipt.data.kind === 'blocked' ? 'action_operation_failed'
                : receipt.data.kind === 'failed' ? receipt.data.reasonCode : receipt.data.reason;
              deps.store.fail(operationId, { errorCode, error: errorCode }, receipt.data);
              return executionResult;
            }
          }
          if (action.actionId === 'session.spawn_new' && executionResult.ok) {
            const settlement = SessionSpawnNewResultV1Schema.safeParse(executionResult.result);
            if (settlement.success && settlement.data.type === 'pending') {
              deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: 'outcome_uncertain' });
              return executionResult;
            }
          }
          const adoption = action.actionId === 'machines.services.adopt' && executionResult.ok
            ? MachineServiceAdoptResultV1Schema.safeParse(executionResult.result) : null;
          if (adoption?.success && adoption.data.kind === 'partial') {
            deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: adoption.data.errorCode }, adoption.data);
            return executionResult;
          }
          if (isUnconfirmedOwnedOutcome(action.actionId, executionResult) && !executionResult.ok) {
            deps.store.updateObservation(operationId, { kind: executionResult.errorCode === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: executionResult.errorCode });
            return executionResult;
          }
          if (action.actionId === 'machines.managed.acquire' && executionResult.ok
            && deps.store.get(request.scope, operationId)?.observation?.kind === 'outcome_uncertain') {
            // Compute acceptance is not confirmation that the ordinary guest
            // Session has started. Its actual owner retains this uncertainty.
            return executionResult;
          }
          if (!executionResult.ok && executionResult.errorCode === 'cancelled') {
            deps.store.cancel(operationId);
          } else if (executionResult.ok) {
            terminalSuccess = deps.store.succeed(operationId, executionResult.result);
            settleReviewedIsolationPredecessors({ store: deps.store, scope: request.scope, action, operationId,
              requestInput: request.input, result: executionResult.result, isActive: heldId => active.has(heldId) });
            const completed = deps.store.get(request.scope, operationId)?.domainRef;
            const setupResult = action.actionId === 'projects.prepare'
              ? ProjectPrepareNoLaunchResultV1Schema.safeParse(executionResult.result) : null;
            if (setupResult?.success && setupResult.data.kind === 'success'
              && completed?.kind === 'projectCommand' && completed.purpose === 'setup') {
              // Completion is target-local evidence, not remembered consent.
              // Wake the existing continuation, which joins any in-flight
              // review and revalidates input, custody and setup success.
              for (const [heldId, invocation] of active) {
                const held = deps.store.get(request.scope, heldId);
                const target = held?.domainRef;
                if (held?.setupReview && target?.kind === 'projectCommand'
                  && (target.purpose === 'setup' || target.purpose === 'script' || target.purpose === 'exec')
                  && held.setupReview.reviewedEffectDigest === setupResult.data.reviewedEffectDigest
                  && target.serverId === completed.serverId && target.machineId === completed.machineId
                  && target.workspaceRefId === completed.workspaceRefId && target.cwd === completed.cwd) {
                  invocation.resumeSetupReview();
                }
              }
            }
          } else {
            const failure = { errorCode: executionResult.errorCode, error: executionResult.error,
              ...(executionResult.failureCause ? { failureCause: executionResult.failureCause } : {}) };
            // Only named Project, Machine setup and managed-controller producers carry these
            // validated public facts. Arbitrary executor details remain private.
            const reviewedFailure = isFiniteProjectCommand(action.actionId) || action.actionId.startsWith('machines.managed.')
              || action.actionId === 'machines.setup.apply'
              || action.actionId === 'machines.setup.remove' || action.actionId === 'machines.setup.updates.apply'
              ? ActionOperationFailureV1Schema.safeParse({ ...failure, details: executionResult.details }) : null;
            deps.store.fail(operationId, reviewedFailure?.success ? reviewedFailure.data : failure);
          }
          return executionResult;
        } catch (error) {
          terminalSuccess = null;
          const { ok: _ok, ...projected } = projectActionOperationFailure(error, 'action_operation_failed', action.actionId);
          const acceptedFinite = isFiniteProjectCommand(action.actionId)
            && deps.store.get(request.scope, operationId)?.domainRef?.kind === 'projectCommand';
          if (acceptedFinite) {
            deps.store.updateObservation(operationId, { kind: controller.signal.aborted ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: projected.errorCode });
            throw error;
          }
          if (isUnconfirmedOwnedOutcome(action.actionId, { ok: false, ...projected })) {
            deps.store.updateObservation(operationId, { kind: projected.errorCode === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: projected.errorCode });
          }
          if (!isUnconfirmedOwnedOutcome(action.actionId, { ok: false, ...projected })
            && (action.actionId !== 'session.handoff' || projected.errorCode !== 'indeterminate')) {
            if (projected.errorCode === 'cancelled') deps.store.cancel(operationId);
            else deps.store.fail(operationId, projected);
          }
          throw error;
        } finally {
          // An indeterminate Move retains an observation, not an executing
          // coordinator. Its retired AbortController cannot clean up an unknown
          // native instance; do not advertise a cancellation owner that is gone.
          if (action.actionId === 'projects.service.relocate') deps.store.updateCancellation(operationId, 'unsupported');
          active.delete(operationId);
          const publish = deps.publishSnapshotAcknowledged;
          const effect = lastEffect;
          const snapshot = terminalSuccess;
          if (snapshot && effect && publish) {
            // Settlement and active ownership finish before this transport-only
            // continuation. Missing Home admission or a failed last effect leaves
            // the known result intact; neither is another running operation.
            void Promise.resolve().then(() => publish(snapshot)).then(async admitted => {
              if (admitted) await effect();
            }).catch(() => undefined);
          }
        }
      });
      // Session creation publishes an accepted/pending receipt once the row and
      // native launch are admitted, but its keyed caller still owns the same
      // lifecycle through native open or refusal. Keep that caller attached to
      // the terminal execution result; genuine uncertain outcomes returned by
      // the executor remain typed `pending` results.
      const response = action.actionId === 'session.spawn_new'
        ? result
        : Promise.race([result, acceptance]);
      active.set(operationId, { actionId: action.actionId, scope: request.scope, controller, cancellation, result, response,
        ...(action.actionId === 'projects.service.relocate' ? { serviceMoveStart: { claimed: false } } : {}),
        resumeSetupReview: retainedReview.resume,
        refreshSetupReview: retainedReview.refresh,
        decideSetupReview: retainedReview.decide,
        notifyCancellationRequested: () => { for (const listener of cancellationListeners) listener(); } });
      return await response;
    };
    if (existing) {
      request.onOperation?.(existing);
      const invocation = active.get(existing.operationId);
      if (invocation) {
        if (existing.setupReview) invocation.resumeSetupReview();
        return await invocation.response;
      }
      // Deferred approval is an intermediate result from the generic Action
      // executor, not the tracked Action's terminal effect. Retain its receipt as
      // history, but never let it preempt the approved continuation or delegate
      // that generic distinction to per-Action re-entry policy.
      const pendingApproval = existing.state === 'succeeded'
        && ActionApprovalRequestCreatedResultSchema.safeParse(existing.result).success;
      if (!pendingApproval && isFiniteProjectCommand(action.actionId) && existing.domainRef?.kind === 'projectCommand') {
        return { ok: true, result: { operation: existing } };
      }
      const settled = terminalResult(existing);
      const reentry = pendingApproval
        ? 'fresh'
        : action.operationReentry?.(existing) ?? (settled ? 'replay' : 'refuse');
      if (reentry === 'replay' && settled) return settled;
      if (reentry === 'reinvoke') return await invoke(existing.operationId, existing.cancellation);
      if (reentry === 'resume') return await invoke(existing.operationId, existing.cancellation, true);
      if (reentry !== 'fresh') {
        return { ok: false, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
      }
      // A fresh re-entry starts a new receipt while retaining the prior approval,
      // terminal, or uncertain evidence as history.
    }
    // Final retirement closes only new finite admission. Exact request replay
    // above still observes the original retained invocation and its Stop owner.
    if (finiteRetirement && isFiniteProjectCommand(action.actionId)) {
      return { ok: false, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
    }
    const operationId = generateOperationId();
    const cancellation = request.cancellation ?? 'unsupported';
    const created = deps.store.create({
      operationId,
      actionId: action.actionId,
      scope: request.scope,
      ...(request.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: request.requesterWorkAttributionV1 } : {}),
      title: action.title,
      cancellation,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.domainRef ? { domainRef: request.domainRef } : {}),
      inputIdentity,
    });
    request.onOperation?.(created);
    if (!isFiniteProjectCommand(action.actionId)) deps.store.markRunning(operationId);
    return await invoke(operationId, cancellation);
  };

  const cancel = (scope: ActionOperationQueryScope, operationId: string): ActionOperationCancelV1Response => {
    const snapshot = deps.store.get(scope, operationId);
    if (!snapshot) return { kind: 'not_found' };
    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      return { kind: 'already_settled' };
    }
    const invocation = active.get(operationId);
    if (!invocation || invocation.cancellation === 'unsupported') return { kind: 'unsupported' };
    invocation.controller.abort(createCancellationRequestError());
    invocation.notifyCancellationRequested();
    return { kind: 'requested' };
  };

  const waitForTerminal = async (scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal,
    requireSettlement = false, includeSetupReview = false) => {
    const snapshot = deps.store.get(scope, operationId);
    if (!snapshot || terminalResult(snapshot) || !requireSettlement && snapshot.observation || includeSetupReview && snapshot.setupReview) return snapshot;
    const invocation = active.get(operationId);
    if (!invocation && !requireSettlement) return snapshot;
    // Cancelling observation is not a request to stop the admitted command.
    if (signal?.aborted) throw signal.reason ?? createCancellationRequestError();
    let onAbort: (() => void) | undefined;
    let unsubscribe = () => {};
    try {
      const completion = new Promise<ReturnType<typeof deps.store.get>>(resolve => {
          const inspect = () => {
            const current = deps.store.get(scope, operationId);
            if (current && (terminalResult(current) || !requireSettlement && current.observation || includeSetupReview && current.setupReview)) resolve(current);
          };
          unsubscribe = deps.store.subscribe(inspect);
          inspect();
          if (!requireSettlement) void invocation!.result.catch(() => undefined).then(() => resolve(deps.store.get(scope, operationId)));
        });
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason ?? createCancellationRequestError());
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([completion, aborted]);
    } finally {
      unsubscribe();
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };

  return Object.freeze({
    observe,
    cancel,
    claimServiceMoveStart(scope: ActionOperationQueryScope, requestId: string, input: ProjectServiceRelocateInputV1): ProjectServiceMoveStartClaimResultV1 {
      const snapshot = deps.store.findByRequestIdentity(scope, 'projects.service.relocate', requestId);
      const invocation = snapshot ? active.get(snapshot.operationId) : undefined;
      if (!snapshot || snapshot.state !== 'running' || snapshot.observation
        || snapshot.progress?.kind !== 'phase' || snapshot.progress.phase !== 'starting'
        || !invocation?.serviceMoveStart || invocation.controller.signal.aborted
        || !deps.store.hasMatchingInputIdentity(snapshot.operationId, createCanonicalJsonSigningInput(input))) {
        return { kind: 'refused', reasonCode: 'service_move_not_starting' };
      }
      if (invocation.serviceMoveStart.claimed) return { kind: 'refused', reasonCode: 'service_move_start_already_claimed' };
      // No await between currentness and consumption. The existing invocation
      // retires this permission on cancellation, settlement or coordinator exit.
      invocation.serviceMoveStart.claimed = true;
      return { kind: 'claimed' };
    },
    async refreshSetupReview(scope: ActionOperationQueryScope, operationId: string): Promise<void> {
      if (!deps.store.get(scope, operationId)?.setupReview) return;
      await active.get(operationId)?.refreshSetupReview();
    },
    /** Called only by the admitted human projects.prepare path; retains original execution custody. */
    async decideSetupReview(scope: ActionOperationQueryScope, operationId: string, workspace: WorkspaceAddressV1,
      phase: 'setup' | 'teardown', decision: ActionOperationSetupDecision) {
      const snapshot = deps.store.get(scope, operationId);
      const invocation = active.get(operationId);
      const target = snapshot?.domainRef;
      if (!snapshot?.setupReview || !invocation || invocation.controller.signal.aborted || target?.kind !== 'projectCommand'
        || target.serverId !== workspace.serverId || target.machineId !== workspace.machineId
        || target.workspaceRefId !== workspace.workspaceId
        || normalizeWorkspaceRootPathV1(target.cwd) !== normalizeWorkspaceRootPathV1(workspace.rootPath)
        || (target.purpose === 'teardown' ? 'teardown' : 'setup') !== phase) return null;
      await invocation.decideSetupReview(decision);
      return deps.store.get(scope, operationId);
    },
    /** Final ingress is already closed; every registration shares this one Stop pass and settlement wait. */
    retireProjectFiniteOperations(): Promise<void> {
      if (!finiteRetirement) {
        const captured = [...active.entries()].filter(([, invocation]) => isFiniteProjectCommand(invocation.actionId));
        const settlement = captured.map(([operationId, invocation]) => waitForTerminal(invocation.scope, operationId, undefined, true));
        finiteRetirement = Promise.all(settlement).then(() => undefined);
        for (const [operationId, invocation] of captured) cancel(invocation.scope, operationId);
      }
      return finiteRetirement;
    },
    /** Mounted package scripts wait for their real script attachment, never an earlier setup PTY. */
    async waitForProjectTerminalAttachment(scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal) {
      if (signal?.aborted) throw signal.reason ?? createCancellationRequestError();
      return await new Promise<import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null>((resolve, reject) => {
        let unsubscribe = () => {};
        const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(signal?.reason ?? createCancellationRequestError()); };
        const observeSnapshot = () => {
          const snapshot = deps.store.get(scope, operationId);
          if (!snapshot || terminalResult(snapshot) || snapshot.observation
            || (snapshot.domainRef?.kind === 'projectCommand' && snapshot.domainRef.purpose === 'script' && snapshot.domainRef.terminalId)
            || !active.has(operationId)) {
            cleanup();
            resolve(snapshot);
          }
        };
        unsubscribe = deps.store.subscribe(observeSnapshot);
        signal?.addEventListener('abort', abort, { once: true });
        observeSnapshot();
      });
    },
    /** Internal consequence of an authenticated last-grant loss, not public revoked-user ingress. */
    async cancelForAccessLoss(
      scope: Pick<ActionOperationQueryScope, 'accountId' | 'machineId'>,
      verifyCurrentMachineAdmission?: () => Promise<boolean>,
      requester?: RequesterWorkAttributionV1,
    ): Promise<readonly Readonly<{
      operationId: string; result: ActionOperationCancelV1Response | Readonly<{ kind: 'admission_not_current' }>;
    }>[]> {
      const captured = deps.store.list({ accountId: scope.accountId, machineId: scope.machineId,
        states: ['accepted', 'running'] }).items.map(snapshot => ({ snapshot, invocation: active.get(snapshot.operationId) }));
      const results: Array<Readonly<{ operationId: string;
        result: ActionOperationCancelV1Response | Readonly<{ kind: 'admission_not_current' }> }>> = [];
      for (const witness of captured) {
        if (requester) {
          const attribution = deps.store.readRequesterWorkAttribution(witness.snapshot.operationId);
          if (!attribution) {
            results.push({ operationId: witness.snapshot.operationId, result: { kind: 'admission_not_current' } });
            continue;
          }
          if (attribution.serverId !== requester.serverId || attribution.accountId !== requester.accountId
            || attribution.machineId !== requester.machineId || attribution.installationId !== requester.installationId) continue;
        }
        let current = true;
        try { if (verifyCurrentMachineAdmission) current = await verifyCurrentMachineAdmission(); }
        catch { current = false; }
        const snapshot = deps.store.get(scope, witness.snapshot.operationId);
        // Never cancel a replacement invocation selected while a Home read was pending.
        const sameInvocation = active.get(witness.snapshot.operationId) === witness.invocation;
        results.push({ operationId: witness.snapshot.operationId, result: !current || !sameInvocation && snapshot && !terminalResult(snapshot)
          ? { kind: 'admission_not_current' }
          : cancel(witness.snapshot.scope, witness.snapshot.operationId) });
      }
      return results;
    },
    async waitForTerminal(scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal,
      options?: Readonly<{ includeSetupReview?: true }>) {
      return await waitForTerminal(scope, operationId, signal, false, options?.includeSetupReview === true);
    },
  });
}

export type ActionOperationRunner = ReturnType<typeof createActionOperationRunner>;
