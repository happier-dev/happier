import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineSetupApplyResultV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';
import { randomUUID } from 'node:crypto';
import { isProjectCheckoutRemovalActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { createPendingSessionBirth } from './pendingSessionBirth';
import { MACHINE_REACHABILITY_ACTION_IDS_V1, MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/reachability/actionIdsV1';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, isDeploymentTargetLinkActionIdV1, isDeploymentDomainChildActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

import type {
  ActionOperationCancelV1Response,
  ActionExecuteResult,
} from '@happier-dev/protocol/actions';
import { ActionOperationDomainRefV1Schema, ActionOperationFailureV1Schema, ActionOperationObservationV1Schema,
  canRetainProjectSetupReviewV1, readActionOperationTerminalResultV1, projectDeploymentBackupFailureResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { ProjectPrepareNoLaunchResultV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { OpenProjectResultV1Schema, projectOpenProjectRefusalV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineReachabilityConfigureResultV1Schema } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { MachineServiceAdoptResultV1Schema } from '@happier-dev/protocol/local/services/adoptionV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionSpawnNewActionInputV2Schema, admitSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { normalizeSessionCreationSelectionIdentityV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ProjectServiceRelocateInputV1, ProjectServiceMoveStartClaimResultV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { MachineServiceControlResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { MachineServiceExecResultV1Schema } from '@happier-dev/protocol/local/services/serviceExecV1';
import { MachineStorageDockerPruneResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { MachineAdminAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineRebootResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/reboot';
import { MachineAgentIsolationSetResultV1Schema } from '@happier-dev/protocol/machines/agentIsolationV1';

import { DeploymentActionOutputSchemasV1, projectDeploymentTargetLinkFailureV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { parseActionOperationProgressUpdate } from './actionOperationProgress';
import { projectActionOperationFailure } from './actionOperationFailure';
import { createActionOperationSetupReview } from './actionOperationSetupReview';
import { settleReviewedIsolationPredecessors } from './settleReviewedIsolationPredecessors';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { ActionOperationStore } from './actionOperationStore';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import type {
  ActionOperationCancellation,
  ActionOperationCancellationContext,
  ActionOperationOwnerUpdate,
  ActionOperationProgressUpdate,
  ActionOperationQueryScope,
  ActionOperationScope,
  ResolvedTrackedAction,
  ActionOperationReviewContinuation,
  ActionOperationSetupDecision,
  DeploymentTokenOperationOrigin,
  ManagedWorkflowContinuationResult,
} from './actionOperationTypes';

type ActiveInvocation = Readonly<{
  actionId: string;
  input: unknown;
  scope: ActionOperationScope;
  controller: AbortController;
  cancellation: 'unsupported' | 'supported';
  result: Promise<ActionExecuteResult>;
  acceptance: Promise<ActionExecuteResult>;
  notifyCancellationRequested: () => void;
  prepareCancellation: (context: ActionOperationCancellationContext) => Promise<void>;
  resumeSetupReview: () => void;
  refreshSetupReview: () => Promise<void>;
  decideSetupReview: (decision: ActionOperationSetupDecision) => Promise<void>;
  serviceMoveStart?: { claimed: boolean };
}>;

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
    || actionId === 'machines.services.control' || actionId === 'machines.services.exec' || actionId === 'machines.storage.docker.prune') {
    return !result.ok && result.errorCode === 'action_outcome_unknown';
  }
  if (actionId === 'daemon.filesystem.upload' || actionId === 'daemon.filesystem.download' || actionId === 'daemon.filesystem.copy') {
    return !result.ok && result.errorCode === 'indeterminate';
  }
  return (isFiniteProjectCommand(actionId) || actionId === 'projects.service.relocate' || actionId === 'localServices.launcher.start'
    || actionId === 'machines.setup.apply') && !result.ok
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
  const sessionBirth = createPendingSessionBirth(deps.store, id => active.has(id));
  let finiteRetirement: Promise<void> | undefined;

  const observe = async (request: Readonly<{
    actionId: string;
    originRunId?: string;
    action?: ResolvedTrackedAction;
    /** Verified retained deployment correspondence from the receiving host, never wire input. */
    restoredDeploymentOperationId?: string;
    /** Observation only: a prepared host callback may never create or restart. */
    existingDeploymentOperationId?: string;
    /** Observation only: admission returns early; terminal waits for the handler result. */
    response?: 'admission' | 'terminal';
    /** Captured by the admitted host-only Workflow acquisition continuation. */
    readWorkflowContinuationResult?: () => ManagedWorkflowContinuationResult | undefined;
    requestId?: string;
    /** Original carried confirmation retries observe an existing proposal, not its decision. */
    rejoinPendingApproval?: true;
    approvedActionReplay?: import('@happier-dev/protocol/actions').ActionExecutorContext['approvedActionReplay'];
    input?: unknown;
    /** Host domain correspondence only; every root retains its own receipt. */
    joinEarlierActive?: (input: unknown) => boolean;
    /** The admitting owner's public refusal projection also serves retained replies. */
    failureResult?: Readonly<{
      project: (failure: Extract<ActionExecuteResult, { ok: false }>) => unknown;
      read: (result: unknown) => Extract<ActionExecuteResult, { ok: false }> | null;
    }>;
    deploymentChildIdentity?: string;
    deploymentTokenOrigin?: DeploymentTokenOperationOrigin;
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
      earlierActiveResult?: Promise<ActionExecuteResult>;
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      updateProgress: (update: ActionOperationProgressUpdate) => void;
      publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
      operationAcceptance?: import('@happier-dev/protocol').ActionExecutorContext['operationAcceptance'];
      onCancellationRequested: ActionOperationCancellation['onRequest'];
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
    if (request.existingDeploymentOperationId && (request.actionId !== 'deployments.deploy'
      || !existing || existing.operationId !== request.existingDeploymentOperationId
      || existing.state !== 'accepted' && existing.state !== 'running'
      || !active.has(existing.operationId) || active.get(existing.operationId)?.controller.signal.aborted)) {
      return { ok: false, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
    }
    const spawnInput = request.actionId === 'session.spawn_new' ? SessionSpawnNewActionInputV2Schema.safeParse(request.input) : null;
    const spawnSelection = spawnInput?.success ? admitSessionSpawnNewActionInputV2(spawnInput.data) : null;
    // Observation does not change executable input or the retained creation identity.
    const { observeSessionCommit: _observer, ...spawnIdentity } = spawnSelection ?? {};
    const terminalSpawnObserver = action.actionId === 'session.spawn_new' && spawnSelection?.observeSessionCommit !== true;
    const approvedDeploymentObserver = action.actionId === 'deployments.deploy' && Boolean(request.approvedActionReplay);
    const observeInvocation = async (operationId: string, invocation: Pick<ActiveInvocation, 'result' | 'acceptance'>): Promise<ActionExecuteResult> => {
      if (request.response === 'admission') {
        void invocation.result.catch(() => undefined);
        return { ok: true, result: { status: 'accepted', operationId, machineId: request.scope.machineId } };
      }
      if (!approvedDeploymentObserver) return await (terminalSpawnObserver || request.response === 'terminal'
        ? invocation.result : Promise.race([invocation.result, invocation.acceptance]));
      // Approval settlement consumes the existing operation's terminal evidence,
      // while ordinary callers can still return its earlier private acceptance.
      const settledResult = () => {
        const snapshot = deps.store.get(request.scope, operationId);
        return snapshot ? readActionOperationTerminalResultV1(snapshot) : null;
      };
      try {
        const result = await invocation.result;
        return settledResult() ?? result;
      }
      catch (error) {
        const settled = settledResult();
        if (settled) return settled;
        throw error;
      }
    };
    const inputIdentity = createCanonicalJsonSigningInput(spawnSelection
      ? { ...spawnIdentity, ...normalizeSessionCreationSelectionIdentityV1(spawnSelection) }
      : request.input === undefined ? null : request.input);
    const reviewedReentry = existing?.observation?.kind === 'review_required' && !active.has(existing.operationId)
      && action.operationReentry?.(existing, request.input) === 'resume';
    const hasMatchingInputIdentity = existing ? deps.store.hasMatchingInputIdentity(existing.operationId, inputIdentity) : false;
    const hasMatchingOrigin = !existing || deps.store.hasMatchingDeploymentChildIdentity(existing.operationId, request.deploymentChildIdentity)
      && deps.store.hasMatchingDeploymentTokenOrigin(existing.operationId, request.deploymentTokenOrigin);
    // Only the domain's fresh-admission policy can replace failed prepared input,
    // and only after the owner positively recorded that no effect was attempted.
    const noEffectFreshReentry = existing && hasMatchingOrigin && !hasMatchingInputIdentity
      && existing.state === 'failed' && existing.error?.effectAttempted === false && !active.has(existing.operationId)
      && action.operationReentry?.(existing, request.input) === 'freshEquivalentInput';
    if (existing && (!hasMatchingOrigin || !hasMatchingInputIdentity && !reviewedReentry && !noEffectFreshReentry)) {
      return await timeWebLatencyPhase('action.operation.input_conflict', () => ({
        ok: false as const, errorCode: 'action_request_input_conflict', error: 'action_request_input_conflict',
      }), undefined, () => ({ operationId: existing.operationId,
        ...(request.requestId ? { executionRequestId: request.requestId } : {}), inputIdentityEqual: false }));
    }
    const previousRestoreSnapshot = action.actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
      && existing?.observation?.kind === 'review_required' && existing.observation.code === 'restore_snapshot_not_confirmed'
      ? existing.observation.snapshot : undefined;
    const previousCreation = action.actionId === 'session.spawn_new' && (existing?.state === 'succeeded' || existing?.state === 'failed')
      ? SessionSpawnNewActionResultV1Schema.safeParse(existing.result) : null;
    const previousSessionCreationFailure = previousCreation?.success && previousCreation.data.type === 'error'
      && previousCreation.data.retryable ? previousCreation.data : undefined;
    const invoke = async (
      operationId: string,
      cancellation: 'unsupported' | 'supported',
      resumeActionRequest = false,
    ): Promise<ActionExecuteResult> => {
      // Select before scheduling this invocation. Only preceding active work
      // can be joined, so simultaneous roots cannot form a cycle.
      const joinEarlierActive = request.joinEarlierActive;
      const earlier = joinEarlierActive ? [...active.values()].find(candidate =>
        candidate.actionId === action.actionId && candidate.scope.accountId === request.scope.accountId
        && candidate.scope.machineId === request.scope.machineId && !candidate.controller.signal.aborted
        && joinEarlierActive(candidate.input)) : undefined;
      const controller = new AbortController();
      const retainedReview = createActionOperationSetupReview({ signal: controller.signal,
        publish: details => { deps.store.updateSetupReview(operationId, details); } });
      const operationReview: ActionOperationReviewContinuation = {
        waitForResume: (details, producer) => {
          if (!canRetainProjectSetupReviewV1(action.actionId)) return Promise.reject(new Error('action_operation_unavailable'));
          return retainedReview.operationReview.waitForResume(details, producer);
        },
      };
      const cancellationListeners = new Set<Parameters<ActionOperationCancellation['onRequest']>[0]>();
      const ownerEvidence: { outcome?: ActionExecuteResult } = {};
      let lastEffect: (() => Promise<void>) | undefined;
      let terminalSuccess: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null = null;
      const onCancellationRequested: ActionOperationCancellation['onRequest'] = (listener) => {
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
        if (update.outcome !== undefined) {
          ownerEvidence.outcome = update.outcome;
          if (isDeploymentTargetLinkActionIdV1(action.actionId) && update.outcome.ok) {
            // Persist returned provider coordinates before later association can fail.
            const result = DeploymentActionOutputSchemasV1[action.actionId].parse(update.outcome.result);
            deps.store.updateObservation(operationId, null, result);
          }
        }
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
            ...(earlier ? { earlierActiveResult: earlier.result } : {}),
            updateProgress,
            publishOwnerUpdate,
            onCancellationRequested,
            operationReview,
            afterTerminalSuccessAcknowledged: effect => {
              lastEffect = effect;
            },
            operationAcceptance: { operationId, actionId: action.actionId,
              originRunId: deps.store.get(request.scope, operationId)?.originRunId,
              ...(action.actionId === 'session.spawn_new' ? {
                observeSessionBirth: (read: () => Promise<import('@happier-dev/protocol').SessionSpawnNewResultV1 | null>) => sessionBirth.retain(operationId, read),
              } : {}),
              ...(previousSessionCreationFailure ? { previousSessionCreationFailure } : {}),
              ...(resumeActionRequest && previousRestoreSnapshot ? { previousRestoreSnapshot } : {}), accept: (result) => {
              if (isFiniteProjectCommand(action.actionId)) acceptFinite();
              else {
                // Combined Setup keeps its public Run link while active, so a
                // reopened surface can follow its native child. This receipt
                // does not settle the root or retain other Actions' private output.
                if (action.actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1) {
                  const receipt = MachineSetupApplyResultV1Schema.safeParse(result);
                  if (receipt.success && receipt.data.runId && receipt.data.operationId === operationId) {
                    deps.store.updateObservation(operationId, null, receipt.data);
                  }
                }
                accept({ ok: true, result });
              }
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
          if (resumeActionRequest && existing?.observation?.kind === 'review_required' && executionResult.ok
            && ActionApprovalRequestCreatedResultSchema.safeParse(executionResult.result).success) {
            // An explicit Ask during a reviewed resume does not complete the
            // original native operation. Retain both its review and the real
            // intermediate approval so the decision resumes this same receipt.
            deps.store.updateObservation(operationId, existing.observation, executionResult.result);
            return executionResult;
          }
          if (deps.store.get(request.scope, operationId)?.observation?.kind === 'review_required') {
            return executionResult;
          }
          if (isUnconfirmedNativeOutcome(action.actionId, nativeOutcome)) {
            // A later handler failure is still returned intact, but cannot
            // turn an unconfirmed physical effect into known terminal evidence.
            deps.store.updateObservation(operationId, { kind: 'outcome_uncertain',
              code: handlerResult.ok ? nativeOutcome.errorCode : handlerResult.errorCode });
            const receipt = action.actionId === 'machines.services.control' && handlerResult.ok
              ? MachineServiceControlResultV1Schema.safeParse(handlerResult.result) : null;
            if (receipt?.success && receipt.data.kind === 'outcome_unknown'
              && receipt.data.operation.operationId === operationId) return handlerResult;
            const command = action.actionId === 'machines.services.exec' && handlerResult.ok
              ? MachineServiceExecResultV1Schema.safeParse(handlerResult.result) : null;
            if (command?.success && 'kind' in command.data && command.data.kind === 'outcome_unknown') return handlerResult;
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
          if (action.actionId === 'machines.setup.adminAccess.set' && executionResult.ok) {
            const receipt = MachineAdminAccessMutationResultV1Schema.safeParse(executionResult.result);
            if (receipt.success) {
              const result = receipt.data;
              const needsAttendance = 'effect' in result && result.effect?.outcome === 'needs_attendance';
              if (needsAttendance || 'effect' in result && result.effect?.outcome === 'outcome_unknown' || result.status === 'outcomeUnknown') {
                deps.store.updateCancellation(operationId, 'unsupported');
                deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: needsAttendance ? 'needs_attendance' : 'action_outcome_unknown' });
                return executionResult;
              }
              if (result.status === 'cancelled' || 'effect' in result && result.effect?.outcome === 'not_applied'
                && result.effect.reasonCode === 'cancelled') {
                deps.store.cancel(operationId);
                return executionResult;
              }
              if ('effect' in result && result.effect?.outcome === 'not_applied') {
                const errorCode = result.effect.reasonCode;
                const failure = result.effect.failure;
                deps.store.fail(operationId, { errorCode, error: errorCode,
                  ...(failure ? { details: { kind: 'machineSetup', failure } } : {}) });
                return executionResult;
              }
              if (result.status === 'conflict' || result.status === 'invalid' || result.status === 'locked' || result.status === 'unavailable') {
                deps.store.fail(operationId, { errorCode: result.status, error: result.status }, result);
                return executionResult;
              }
            }
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
          if (action.actionId === 'session.spawn_new') {
            const settlement = SessionSpawnNewActionResultV1Schema.safeParse(
              executionResult.ok ? executionResult.result : executionResult.details,
            );
            if (settlement.success && settlement.data.type === 'error') {
              sessionBirth.settleFailure(operationId, settlement.data);
              return executionResult;
            }
            if (executionResult.ok && settlement.success && settlement.data.type === 'pending') {
              deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: 'outcome_uncertain' });
              return executionResult;
            }
          }
          const reachability = action.actionId === MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1 && executionResult.ok
            ? MachineReachabilityConfigureResultV1Schema.safeParse(executionResult.result) : null;
          if (reachability?.success && reachability.data.status === 'outcome_unknown') {
            deps.store.updateObservation(operationId, { kind: 'outcome_uncertain',
              code: reachability.data.errorCode ?? 'action_outcome_unknown' }, reachability.data);
            return executionResult;
          }
          const adoption = action.actionId === 'machines.services.adopt' && executionResult.ok
            ? MachineServiceAdoptResultV1Schema.safeParse(executionResult.result) : null;
          if (adoption?.success && adoption.data.kind === 'partial') {
            deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: adoption.data.errorCode }, adoption.data);
            return executionResult;
          }
          const projectOpen = action.actionId === 'projects.open' && executionResult.ok
            ? OpenProjectResultV1Schema.safeParse(executionResult.result) : null;
          if (projectOpen?.success && projectOpen.data.kind === 'outcomeUnknown') {
            deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: 'action_outcome_unknown' }, projectOpen.data);
            return executionResult;
          }
          if (projectOpen?.success && projectOpen.data.kind === 'refused') {
            const { ok: _ok, ...failure } = projectOpenProjectRefusalV1(projectOpen.data);
            deps.store.fail(operationId, failure, projectOpen.data);
            return executionResult;
          }
          if (isUnconfirmedOwnedOutcome(action.actionId, executionResult) && !executionResult.ok) {
            deps.store.updateObservation(operationId, { kind: executionResult.errorCode === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: executionResult.errorCode }, undefined, {
              errorCode: executionResult.errorCode, error: executionResult.error,
              ...(executionResult.requestId !== undefined ? { requestId: executionResult.requestId } : {}),
              ...(executionResult.effectAttempted !== undefined ? { effectAttempted: executionResult.effectAttempted } : {}),
              ...(executionResult.failureCause ? { failureCause: executionResult.failureCause } : {}),
            });
            return executionResult;
          }
          if (action.actionId === 'machines.managed.acquire' && executionResult.ok
            && deps.store.get(request.scope, operationId)?.observation?.kind === 'outcome_uncertain') {
            // Compute acceptance is not confirmation that the ordinary guest
            // Session has started. Its actual owner retains this uncertainty.
            return executionResult;
          }
          const isolation = action.actionId === 'machines.agentIsolation.set' && executionResult.ok
            ? MachineAgentIsolationSetResultV1Schema.safeParse(executionResult.result) : null;
          if (isolation?.success && isolation.data.kind === 'failed') {
            const result = isolation.data;
            if (result.code === 'cancelled') deps.store.cancel(operationId, result);
            else {
              const failure = result.setup?.failure;
              deps.store.fail(operationId, { errorCode: failure?.kind ?? result.code,
                error: failure?.remedy ?? result.code,
                ...(failure ? { details: { kind: 'machineSetup', failure } } : {}) }, result);
            }
            return executionResult;
          }
          const failureResult = !executionResult.ok
            ? (executionResult.errorCode === 'cancelled' ? undefined : request.failureResult?.project(executionResult))
              ?? projectDeploymentTargetLinkFailureV1(action.actionId, executionResult.details)?.details
              ?? projectDeploymentBackupFailureResultV1(action.actionId, executionResult.errorCode, executionResult.details) : undefined;
          if (!executionResult.ok && executionResult.errorCode === 'cancelled') {
            deps.store.cancel(operationId, failureResult);
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
              ...(executionResult.requestId !== undefined ? { requestId: executionResult.requestId } : {}),
              ...(executionResult.effectAttempted !== undefined ? { effectAttempted: executionResult.effectAttempted } : {}),
              ...(executionResult.failureCause ? { failureCause: executionResult.failureCause } : {}) };
            // Only named Project, Domain, Network, Machine setup and managed-controller producers carry these
            // validated public facts. Arbitrary executor details remain private.
            const reviewedFailure = isFiniteProjectCommand(action.actionId) || isProjectCheckoutRemovalActionIdV1(action.actionId)
              || action.actionId.startsWith('machines.managed.')
              || action.actionId === MACHINE_PRESET_PREPARE_ACTION_ID_V1
              || MACHINE_REACHABILITY_ACTION_IDS_V1.some(actionId => actionId === action.actionId)
              || action.actionId === 'machines.setup.apply'
              || action.actionId === 'machines.setup.remove' || action.actionId === 'machines.setup.updates.apply'
              || action.actionId === 'deployments.templates.instantiate'
              || isDeploymentDomainChildActionIdV1(action.actionId)
              ? ActionOperationFailureV1Schema.safeParse({ ...failure, details: executionResult.details }) : null;
            deps.store.fail(operationId, reviewedFailure?.success ? reviewedFailure.data : failure, failureResult);
          }
          return executionResult;
        } catch (error) {
          terminalSuccess = null;
          const { ok: _ok, ...projected } = projectActionOperationFailure(error, 'action_operation_failed', action.actionId);
          const nativeOutcome = ownerEvidence.outcome;
          if (isUnconfirmedNativeOutcome(action.actionId, nativeOutcome)) {
            deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: projected.errorCode });
            throw error;
          }
          const acceptedFinite = isFiniteProjectCommand(action.actionId)
            && deps.store.get(request.scope, operationId)?.domainRef?.kind === 'projectCommand';
          if (acceptedFinite) {
            deps.store.updateObservation(operationId, { kind: controller.signal.aborted ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: projected.errorCode });
            throw error;
          }
          if (isUnconfirmedOwnedOutcome(action.actionId, { ok: false, ...projected })) {
            deps.store.updateObservation(operationId, { kind: projected.errorCode === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: projected.errorCode }, undefined, projected);
          }
          if (!isUnconfirmedOwnedOutcome(action.actionId, { ok: false, ...projected })
            && (action.actionId !== 'session.handoff' || projected.errorCode !== 'indeterminate')) {
            if (projected.errorCode === 'cancelled') deps.store.cancel(operationId);
            else deps.store.fail(operationId, projected);
          }
          throw error;
        } finally {
          const workflowResult = request.readWorkflowContinuationResult?.();
          if (workflowResult) deps.store.retainWorkflowContinuationResult(request.scope, operationId, workflowResult);
          // An indeterminate Move retains an observation, not an executing
          // coordinator. Its retired AbortController cannot clean up an unknown
          // native instance; do not advertise a cancellation owner that is gone.
          if (action.actionId === 'projects.service.relocate') deps.store.updateCancellation(operationId, 'unsupported');
          active.delete(operationId);
          // Retired pending creation observes birth once; transport failure is
          // still uncertainty and must not replace the original pending reply.
          await sessionBirth.reconcile(request.scope, operationId).catch(() => undefined);
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
      // Retain both observations on one invocation. Each spawn caller opts in
      // independently; the receipt never changes the native/input lifecycle.
      active.set(operationId, { actionId: action.actionId, input: request.input, scope: request.scope, controller, get cancellation() { return cancellation; }, result, acceptance,
        ...(action.actionId === 'projects.service.relocate' ? { serviceMoveStart: { claimed: false } } : {}),
        resumeSetupReview: retainedReview.resume,
        refreshSetupReview: retainedReview.refresh,
        decideSetupReview: retainedReview.decide,
        notifyCancellationRequested: () => { for (const listener of cancellationListeners) listener(); },
        prepareCancellation: async context => { for (const listener of cancellationListeners) await listener(context); } });
      return await observeInvocation(operationId, { result, acceptance });
    };
    if (existing) {
      request.onOperation?.(existing);
      const invocation = active.get(existing.operationId);
      if (invocation) {
        if (existing.setupReview) invocation.resumeSetupReview();
        return await observeInvocation(existing.operationId, invocation);
      }
      // Deferred approval is an intermediate result from the generic Action
      // executor, not the tracked Action's terminal effect. Retain its receipt as
      // history, but never let it preempt the approved continuation or delegate
      // that generic distinction to per-Action re-entry policy.
      const reviewedPendingApproval = existing.state === 'running' && existing.observation?.kind === 'review_required';
      const pendingApproval = (existing.state === 'succeeded' || reviewedPendingApproval)
        && ActionApprovalRequestCreatedResultSchema.safeParse(existing.result).success;
      if (!pendingApproval && isFiniteProjectCommand(action.actionId) && existing.domainRef?.kind === 'projectCommand') {
        return { ok: true, result: { operation: existing } };
      }
      // This domain's held result is replayed exactly; only its newly reviewed
      // explicit skip may resume the original, still-unconsumed restore.
      if (previousRestoreSnapshot && hasMatchingInputIdentity) return { ok: false,
        errorCode: 'restore_snapshot_not_confirmed', error: 'restore_snapshot_not_confirmed',
        details: { steps: [], snapshot: previousRestoreSnapshot } };
      const terminal = readActionOperationTerminalResultV1(existing);
      const refusal = existing.state === 'failed' && terminal && !terminal.ok
        ? request.failureResult?.read(existing.result) : null;
      const settled = (refusal && terminal ? { ...terminal, ...refusal } : terminal) ?? (pendingApproval && reviewedPendingApproval ? { ok: true as const, result: existing.result,
        ...(existing.operationCredentialUses ? { operationCredentialUses: existing.operationCredentialUses } : {}) } : null);
      const reentry = pendingApproval
        ? request.rejoinPendingApproval && hasMatchingInputIdentity ? 'replay' : reviewedPendingApproval ? 'resume' : 'fresh'
        : noEffectFreshReentry ? 'fresh' : action.operationReentry?.(existing, request.input) ?? (settled ? 'replay' : 'refuse');
      if (reentry === 'replay' && settled) return settled;
      if (reentry === 'reinvoke') {
        const resumed = deps.store.reenter(existing.operationId);
        return await invoke(existing.operationId, existing.cancellation, resumed?.state === 'running' && existing.state === 'failed');
      }
      if (reentry === 'resume') {
        deps.store.replaceInputIdentity(existing.operationId, inputIdentity);
        deps.store.updateObservation(existing.operationId, null, undefined);
        return await invoke(existing.operationId, existing.cancellation, true);
      }
      if (reentry !== 'fresh' && !(reentry === 'freshEquivalentInput'
        && existing.state === 'failed' && existing.error?.effectAttempted === false)) {
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
    const operationId = request.actionId === 'deployments.deploy' && request.restoredDeploymentOperationId
      ? request.restoredDeploymentOperationId : generateOperationId();
    const cancellation = request.cancellation ?? 'unsupported';
    const created = deps.store.create({
      operationId,
      actionId: action.actionId,
      ...(request.originRunId !== undefined ? { originRunId: request.originRunId } : {}),
      scope: request.scope,
      ...(request.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: request.requesterWorkAttributionV1 } : {}),
      title: action.title,
      cancellation,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.domainRef ? { domainRef: request.domainRef } : {}),
      inputIdentity,
      ...(request.deploymentChildIdentity ? { deploymentChildIdentity: request.deploymentChildIdentity } : {}),
      ...(request.deploymentTokenOrigin ? { deploymentTokenOrigin: request.deploymentTokenOrigin } : {}),
    });
    request.onOperation?.(created);
    if (!isFiniteProjectCommand(action.actionId)) deps.store.markRunning(operationId);
    return await invoke(operationId, cancellation);
  };

  const cancellationTarget = (scope: ActionOperationQueryScope, operationId: string):
    { response: ActionOperationCancelV1Response } | { invocation: ActiveInvocation } => {
    const snapshot = deps.store.get(scope, operationId);
    if (!snapshot) return { response: { kind: 'not_found' } };
    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      return { response: { kind: 'already_settled' } };
    }
    const invocation = active.get(operationId);
    if (!invocation || invocation.cancellation === 'unsupported') return { response: { kind: 'unsupported' } };
    return { invocation };
  };

  const finalizeCancellation = (invocation: ActiveInvocation): ActionOperationCancelV1Response => {
    invocation.controller.abort(createCancellationRequestError());
    return { kind: 'requested' };
  };

  const cancel = (scope: ActionOperationQueryScope, operationId: string): ActionOperationCancelV1Response => {
    const target = cancellationTarget(scope, operationId);
    if ('response' in target) return target.response;
    const result = finalizeCancellation(target.invocation);
    target.invocation.notifyCancellationRequested();
    return result;
  };

  const requestCancellation = async (scope: ActionOperationQueryScope, operationId: string,
    context: ActionOperationCancellationContext): Promise<ActionOperationCancelV1Response> => {
    await context.assertCurrent();
    const target = cancellationTarget(scope, operationId);
    if ('response' in target) return target.response;
    await target.invocation.prepareCancellation(context);
    await context.assertCurrent();
    const current = cancellationTarget(scope, operationId);
    if ('response' in current) return current.response;
    if (current.invocation !== target.invocation) return { kind: 'unsupported' };
    return finalizeCancellation(target.invocation);
  };

  const waitForTerminal = async (scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal,
    requireSettlement = false, includeSetupReview = false, includeManagedPrompt = false) => {
    const hasManagedPrompt = (snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1) => includeManagedPrompt
      && (snapshot.domainRef?.kind === 'systemTask' && Boolean(snapshot.domainRef.prompt)
        || snapshot.domainRef?.kind === 'managedMachine' && Boolean(snapshot.domainRef.bootstrapTask?.prompt));
    const hasApprovalHold = (snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1) => includeSetupReview
      && snapshot.progress?.kind === 'phase' && snapshot.progress.phase === 'waiting_for_approval';
    const snapshot = deps.store.get(scope, operationId);
    if (!snapshot || readActionOperationTerminalResultV1(snapshot) || !requireSettlement && snapshot.observation || includeSetupReview && snapshot.setupReview || hasManagedPrompt(snapshot) || hasApprovalHold(snapshot)) return snapshot;
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
            if (current && (readActionOperationTerminalResultV1(current) || !requireSettlement && current.observation || includeSetupReview && current.setupReview || hasManagedPrompt(current) || hasApprovalHold(current))) resolve(current);
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
    reconcileSessionBirth: sessionBirth.reconcile,
    cancel,
    /** Join the admitted executor without requesting cancellation or trusting an early terminal projection. */
    async waitForCompletion(scope: ActionOperationQueryScope, operationId: string,
      receiveWorkflowResult?: (result: ManagedWorkflowContinuationResult) => void) {
      const snapshot = deps.store.get(scope, operationId);
      if (!snapshot) return null;
      await active.get(operationId)?.result.catch(() => undefined);
      const workflowResult = deps.store.readWorkflowContinuationResult(scope, operationId);
      if (workflowResult) receiveWorkflowResult?.(workflowResult);
      return deps.store.get(scope, operationId);
    },
    requestCancellation,
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
          if (!snapshot || readActionOperationTerminalResultV1(snapshot) || snapshot.observation
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
    async waitForTerminal(scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal,
      options?: Readonly<{ includeSetupReview?: true; includeManagedPrompt?: true }>) {
      return await waitForTerminal(scope, operationId, signal, false, options?.includeSetupReview === true, options?.includeManagedPrompt === true);
    },
  });
}

export type ActionOperationRunner = ReturnType<typeof createActionOperationRunner>;
