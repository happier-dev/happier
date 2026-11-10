import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, ActionOperationDomainRefV1, ActionOperationSnapshotV1, ActionOperationDeclarationV1 } from '@happier-dev/protocol/actions';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";

import { createActionOperationRpcHandlers, resolveActionOperationScope, type ActionOperationRpcContext } from './actionOperationRpcHandlers';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore, type DeploymentBackupOperationTarget } from './actionOperationStore';
import { readDeploymentTokenOperationOrigin } from './deploymentTokenOrigin';
import type { ActionOperationCancellation, ActionOperationDomainOwner, ActionOperationProgressUpdate, HostActionOperationExecute } from './actionOperationTypes';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { RpcError, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import type { LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { isDeepStrictEqual } from 'node:util';
import { readDeploymentArchiveOperationIdentityForHost } from '@/deployments/targets/ownServer/archiveFilesystemAdmission';
import { hasEquivalentDeploymentOperationRetryInput } from '@/deployments/deploymentOperationRetry';
import type { ManagedNativeOperationSettlement, ManagedMachineOperationSettlementContext } from '@/machines/managed/managedIntentReconciler';
import { DeploymentActionInputSchemasV1, DeploymentReceiptResultV1Schema, DeploymentDeployInputV1Schema,
  readDeploymentActionOperationRequestIdV1, isDeploymentTemplatePreviewInputV1,
  type DeploymentDeployInputV1, type DeploymentDeployIntentInputV1,
  type DeploymentPendingAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isDeploymentChildEffectActionIdV1, isDeploymentDomainChildActionIdV1 } from '@happier-dev/protocol';
import { DeploymentDomainFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { MachineServiceAdoptInputV1Schema } from '@happier-dev/protocol/local/services/adoptionV1';
import { ProjectOpenReceiptPersistenceError, type ProjectOpenReceiptPersistence } from './projectOpenReceiptPersistence';

type ConfirmationContext = Pick<ActionExecutorContext, 'presentUserConfirmation' | 'externalActionExecutionAuthorization' | 'approvedActionReplay'>;

export function carriesNativeConfirmation(actionId: string, context?: ConfirmationContext): boolean {
  return Boolean(context?.externalActionExecutionAuthorization && context.presentUserConfirmation?.inputDigest
    && context.presentUserConfirmation.actionId === actionId);
}

export type PendingDeploymentObservationRequest = Readonly<{
  input: DeploymentDeployIntentInputV1;
  admission: DeploymentPendingAdmissionV1;
  pendingDeploy: import('@happier-dev/protocol').DeploymentPendingDeployV1;
  context: import('@happier-dev/protocol').ActionExecutorContext;
  /** Same domain validator, not a consumer-owned candidate parser. */
  validateOriginalInput(input: DeploymentDeployInputV1,
    context: import('@happier-dev/protocol').ActionExecutorContext): Promise<void>;
}>;

/** A native receipt intent survives transport retries. Its exact input remains
 * the runner's conflict authority; the tuple fits the existing request-id bound. */
function readDeploymentOperationRequestId(actionId: string, input: unknown): string | undefined {
  if (actionId === 'machines.services.adopt') {
    const parsed = MachineServiceAdoptInputV1Schema.safeParse(input);
    if (!parsed.success || parsed.data.mode !== 'apply') return undefined;
    return computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
      'adopt', parsed.data.serverId, parsed.data.machineId, parsed.data.serviceId, parsed.data.requestKey,
    ]);
  }
  return readDeploymentActionOperationRequestIdV1(actionId, input);
}

function readRequestId(actionId: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  const candidate = actionId === 'session.spawn_new'
    ? record.creationKey
    : actionId === 'session.handoff'
      ? record.actionRequestId ?? record.requestId
      : record.requestId;
  if (typeof candidate !== 'string') return undefined;
  const normalized = candidate.trim();
  return normalized.length > 0 && normalized.length <= 2_000 ? normalized : undefined;
}

function readInitialDomainRef(
  actionId: string,
  input: unknown,
  requestId: string | undefined,
): ActionOperationDomainRefV1 | undefined {
  if (actionId === 'machines.managed.power.set' || actionId === 'machines.managed.delete' || actionId === 'machines.managed.rebuild') {
    // The Home-scoped operation concerns this guest even when controller admission
    // fails before the native owner can publish its admitted/enriched reference.
    const parsed = ManagedMachineActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success) return undefined;
    return { kind: 'managedMachine', id: 'managedMachineId' in parsed.data ? parsed.data.managedMachineId : parsed.data.managedId };
  }
  if (!requestId) return undefined;
  if (actionId === 'session.spawn_new') return { kind: 'spawnAttempt' as const, id: requestId };
  if (actionId !== 'session.fork') return undefined;
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Readonly<Record<string, unknown>>
    : null;
  const strategy = record?.strategy;
  return {
    kind: 'forkRequest' as const,
    id: requestId,
    ...(strategy === 'native' || strategy === 'replay' ? { strategy } : {}),
  };
}

function observeUntilCallerAbort<T>(result: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return result;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void result.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export function createHostActionOperationRuntime(deps: Readonly<{
  /** Exact configured Home binding, shared with the incumbent Session launch owner. */
  serverId?: string;
  machineId: string;
  /** Captured by the actual installed Machine client, never an Action input. */
  custodyBinding?: Readonly<{ serverId: string; installationId: string }>;
  resolveAccountId: () => Promise<string | null>;
  generateOperationId?: () => string;
  publishSnapshot?: (snapshot: ActionOperationSnapshotV1) => void | Promise<void>;
  publishSnapshotAcknowledged?: (snapshot: ActionOperationSnapshotV1) => Promise<boolean>;
  projectOpenReceiptPersistence?: ProjectOpenReceiptPersistence | null;
  onInspection?: (operation: ActionOperationSnapshotV1) => void;
  supportsCoreCancellation?: (
    actionId: 'session.fork' | 'session.spawn_new' | 'session.handoff' | 'projects.service.relocate',
    input: unknown,
  ) => boolean;
}>) {
  const store = createActionOperationStore({
    ...(deps.publishSnapshot ? { onSnapshot: deps.publishSnapshot } : {}),
    ...(deps.projectOpenReceiptPersistence !== undefined ? { projectOpenReceiptPersistence: deps.projectOpenReceiptPersistence } : {}),
  });
  const runner = createActionOperationRunner({
    store,
    resolveAction: (rawActionId) => {
      const parsed = ActionIdSchema.safeParse(rawActionId);
      const spec = parsed.success ? getActionSpec(parsed.data) : null;
      return spec?.operation
        ? { actionId: spec.id, title: spec.title, operation: spec.operation,
            ...(spec.operationReentry ? { operationReentry: spec.operationReentry } : {}) }
        : null;
    },
    ...(deps.generateOperationId ? { generateOperationId: deps.generateOperationId } : {}),
    ...(deps.publishSnapshotAcknowledged ? { publishSnapshotAcknowledged: deps.publishSnapshotAcknowledged } : {}),
  });
  let owner: ActionOperationDomainOwner | null = null;
  const attachedOwners = new Set<ActionOperationDomainOwner>();
  const rebuildOwner = () => {
    const attached = [...attachedOwners];
    if (attached.length === 0) { owner = null; return; }
    const candidates = (scope: Parameters<ActionOperationDomainOwner['get']>[0], id: string) => {
      const retained = store.get(scope, id);
      return retained ? attached.filter(item => item.actionIds.includes(retained.actionId)) : attached;
    };
    const find = async (scope: Parameters<ActionOperationDomainOwner['get']>[0], id: string) => {
      for (const item of candidates(scope, id)) {
        const snapshot = await item.get(scope, id);
        if (owner !== composite) return null;
        if (snapshot) return { item, snapshot };
      }
      return null;
    };
    // An immutable attachment view preserves the existing stale-reader guard.
    const composite: ActionOperationDomainOwner = {
      actionIds: [...new Set(attached.flatMap(item => item.actionIds))],
      async list(scope) { return (await Promise.all(attached.map(item => item.list(scope)))).flat(); },
      async get(scope, id) { return (await find(scope, id))?.snapshot ?? null; },
      async cancel(scope, id, context) {
        const found = await find(scope, id);
        await context?.assertCurrent();
        if (owner !== composite) return null;
        return found?.item.cancel(scope, id, context) ?? null;
      },
      async refreshSetupReview(scope, id) { await (await find(scope, id))?.item.refreshSetupReview?.(scope, id); },
      async decideSetupReview(scope, id, workspace, phase, decision) {
        return (await find(scope, id))?.item.decideSetupReview?.(scope, id, workspace, phase, decision) ?? null;
      },
      async waitForTerminal(scope, id, signal, options) {
        const found = await find(scope, id);
        return found?.item.waitForTerminal ? await found.item.waitForTerminal(scope, id, signal, options) : found?.snapshot ?? null;
      },
      subscribe(input) {
        const unsubscribe = attached.map(item => item.subscribe(input));
        return () => { for (const detach of unsubscribe) detach(); };
      },
    };
    owner = composite;
  };
  const acceptedAttribution = (scope: Readonly<{ accountId: string; machineId: string }>, context?: ActionOperationRpcContext) =>
    !context?.machineAdmission && context?.requesterSessionBootstrap
      ? RequesterWorkAttributionV1Schema.parse(context.requesterSessionBootstrap.attribution)
      : (deps.custodyBinding?.serverId ?? deps.serverId) && context?.machineAdmission
      ? RequesterWorkAttributionV1Schema.parse({ serverId: deps.custodyBinding?.serverId ?? deps.serverId, accountId: scope.accountId,
        machineId: scope.machineId, installationId: context.machineAdmission.installationId })
      : undefined;
  const handlers = createActionOperationRpcHandlers({
    owner: () => owner,
    store,
    runner,
    machineId: deps.machineId,
    resolveAccountId: deps.resolveAccountId,
    ...(deps.custodyBinding ? { onMissingCancellation: async (scope, operationId, context) => {
      if (context.callerInputAuthorization?.binding.actionId !== 'action.operations.cancel') return null;
      const { cancelPendingDeploymentForHost } = await import('@/deployments/pendingDeploy');
      return cancelPendingDeploymentForHost({ scope, operationId, context, custody: deps.custodyBinding! });
    } } : {}),
    ...(deps.onInspection ? { onInspection: deps.onInspection } : {}),
  });

  const resolveObservedScope = async (context?: ActionOperationRpcContext, sessionId?: string) => {
    const admission = context?.machineAdmission;
    const session = !admission ? context?.requesterSessionBootstrap : undefined;
    if (session && (!deps.custodyBinding || session.attribution.installationId !== deps.custodyBinding.installationId
      || !await isServerProfileHomeIdentity(deps.custodyBinding.serverId, session.attribution.serverId))) {
      throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
    }
    if (admission && ((!deps.custodyBinding && admission.actorAccountId !== admission.custodianAccountId)
      || (deps.custodyBinding && admission.installationId !== deps.custodyBinding.installationId))) {
      throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
    }
    return await resolveActionOperationScope(deps, context, sessionId);
  };

  const observeExecution = async (request: Readonly<{
    actionId: string;
    input: unknown;
    /** Receiving-host metadata for a typed operation arm, never public input. */
    operation?: ActionOperationDeclarationV1;
    actionRequestId?: import('@happier-dev/protocol').ActionExecutorContext['actionRequestId'];
    sessionId?: string;
    /** Already admitted receiving-host context, never a public Action input. */
    rpcContext?: ActionOperationRpcContext & ConfirmationContext;
    /** Existing domain owner opens and validates the exact candidate before returning correspondence. */
    recoverPendingDeployment?: () => Promise<import('@happier-dev/protocol/deployments/deploymentActionsV1').DeploymentPendingAdmissionV1 | undefined>;
    existingDeploymentOperationId?: string;
    onOperation?: (operation: ActionOperationSnapshotV1) => void;
    resumeRetained?: true;
    resume?: HostActionOperationExecute;
    execute: HostActionOperationExecute;
  }>): Promise<ActionExecuteResult> => {
    const scope = await resolveObservedScope(request.rpcContext, request.sessionId);
    const deploymentChildIdentity = await readDeploymentArchiveOperationIdentityForHost(request.rpcContext, request.actionId);
    const settleManagedNativeOperation = scope
      && (request.actionId === 'machines.managed.inspect' || request.actionId === 'machines.managed.delete')
      ? (settlement: ManagedNativeOperationSettlement) => {
        if (settlement.controller && (settlement.controller.machineId !== deps.machineId
          || deps.custodyBinding && settlement.controller.installationId !== deps.custodyBinding.installationId)) return;
        // Confirmed native absence ends setup for this same managed Machine.
        // Reuse each admitted invocation's local cancellation owner, including
        // early acquisition phases that have not yet acquired a resource.
        const acquisitionScope = { accountId: scope.accountId, machineId: scope.machineId };
        for (const candidate of settlement.intent === 'delete'
          ? store.list({ ...acquisitionScope, states: ['accepted', 'running'] }).items : []) {
          const acquiring = candidate.domainRef;
          if ((candidate.actionId === 'machines.managed.acquire' || candidate.actionId === 'machines.managed.bootstrap.retry')
            && acquiring?.kind === 'managedMachine' && acquiring.id === settlement.managedId
            && (!acquiring.controller || isDeepStrictEqual(acquiring.controller, settlement.controller))
            && (!acquiring.resource || isDeepStrictEqual(acquiring.resource, settlement.resource))) {
            runner.cancel(acquisitionScope, candidate.operationId);
          }
        }
        const operation = store.findByRequestIdentity(scope,
          settlement.intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set', settlement.requestId);
        const target = operation?.domainRef;
        // Only the retained uncertain invocation is retired. A running native
        // handler, another resource/controller, or terminal history is untouched.
        if (!operation || operation.state !== 'running' || operation.observation?.kind !== 'outcome_uncertain'
          || operation.observation.code !== 'action_outcome_unknown' || target?.kind !== 'managedMachine'
          || target.id !== settlement.managedId || !isDeepStrictEqual(target.controller, settlement.controller)
          || !isDeepStrictEqual(target.resource, settlement.resource)) return;
        if (settlement.succeeded) store.succeed(operation.operationId, { kind: 'accepted', managedId: settlement.managedId,
          intentRevision: settlement.intentRevision, operation: { operationId: operation.operationId } });
        else store.fail(operation.operationId, { errorCode: 'native_intent_unconfirmed', error: 'native_intent_unconfirmed' });
      } : undefined;
    const actionId = ActionIdSchema.safeParse(request.actionId);
    const spec = actionId.success ? getActionSpec(actionId.data) : null;
    if (!scope || !spec || !(request.operation ?? spec.operation)
      || isDeploymentTemplatePreviewInputV1(request.actionId, request.input)) {
      // Actions without a host operation consume their carried review in the action executor.
      if (!scope && (request.operation ?? spec?.operation)
        && carriesNativeConfirmation(request.actionId, request.rpcContext)) return { ok: false,
        errorCode: 'admission_unavailable', error: 'admission_unavailable' };
      return await request.execute({
        signal: new AbortController().signal,
        operationProgress: { update: () => undefined },
        operationOwnerUpdate: { update: () => undefined },
        ...(settleManagedNativeOperation ? { settleManagedNativeOperation } : {}),
      });
    }
    const attribution = acceptedAttribution(scope, request.rpcContext);
    const deploymentInput = request.actionId === 'deployments.deploy'
      ? DeploymentActionInputSchemasV1['deployments.deploy'].safeParse(request.input) : null;
    const deploymentTokenOrigin = request.actionId === 'deployments.deploy'
      ? readDeploymentTokenOperationOrigin({ actionId: request.actionId, scope, context: request.rpcContext,
          environmentId: deploymentInput?.success ? deploymentInput.data.environmentId : undefined })
      : undefined;
    const cancellableActionId = request.actionId === 'session.fork'
      || request.actionId === 'session.spawn_new'
      || request.actionId === 'session.handoff'
      || request.actionId === 'projects.service.relocate'
      ? request.actionId
      : null;
    const deploymentRequestId = readDeploymentOperationRequestId(request.actionId, request.input);
    const requestId = deploymentRequestId || request.actionRequestId?.trim()
      || readRequestId(request.actionId, request.input);
    const retainedOperation = request.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && requestId
      ? store.findByRequestIdentity(scope, request.actionId, requestId) : null;
    const retainedTeardown = retainedOperation ? store.readRetainedTeardownExecution(scope, retainedOperation.operationId) : undefined;
    if (request.resumeRetained && !retainedTeardown) {
      if (retainedOperation?.domainRef?.kind === 'deployment') return { ok: false,
        errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
      return request.execute({ signal: new AbortController().signal, operationProgress: { update() {} },
        operationOwnerUpdate: { update() {} } });
    }
    let restoredDeploymentOperationId: string | undefined;
    if (request.actionId === 'deployments.deploy' && requestId && request.recoverPendingDeployment && deps.custodyBinding
      && !store.findByRequestIdentity(scope, request.actionId, requestId)) {
      const restored = await request.recoverPendingDeployment();
      if (restored) {
        if (restored.requesterAccountId !== scope.accountId || restored.controller.machineId !== scope.machineId
          || restored.controller.installationId !== deps.custodyBinding.installationId
          || !await isServerProfileHomeIdentity(deps.custodyBinding.serverId, restored.serverId)) {
          throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
        }
        restoredDeploymentOperationId = restored.actionOperationId;
      }
      // A reader may have yielded while another ordinary request was admitted;
      // the incumbent runner remains the sole conflict/rejoin authority.
    }
    const domainRef = readInitialDomainRef(request.actionId, request.input, requestId);
    const teardown = request.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1
      ? DeploymentActionInputSchemasV1['deployments.teardown'].safeParse(request.input) : null;
    let operationInput = request.input;
    if (teardown?.success && 'contentArtifactId' in teardown.data) {
      // The signed transition owner advances this receipt's head. Its Artifact
      // identity and teardown intent, rather than those head versions, identify a retry.
      const { contentHeaderVersion: _header, contentBodyVersion: _body, ...intent } = teardown.data;
      operationInput = intent;
    }
    if (request.resumeRetained && teardown?.success && retainedOperation && !('contentArtifactId' in teardown.data)) {
      const original = store.readDeploymentInvocationInput(scope, retainedOperation.operationId);
      if (!original || typeof original !== 'object' || Array.isArray(original)) return { ok: false,
        errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
      operationInput = { ...original, ...teardown.data };
    }
    let observedOperationId: string | undefined;
    const execution = runner.observe({
      actionId: request.actionId,
      ...(request.operation || request.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? { action: { actionId: spec.id,
        title: spec.title, operation: request.operation ?? spec.operation,
        ...(request.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? {
          operationReentry: (snapshot: ActionOperationSnapshotV1, input?: unknown) => snapshot.state === 'failed'
            && snapshot.error?.effectAttempted === false
            && hasEquivalentDeploymentOperationRetryInput(store.readDeploymentInvocationInput(scope, snapshot.operationId), input)
              ? 'freshEquivalentInput' as const : 'replay' as const,
        } : {}),
      } } : {}),
      scope,
      ...(restoredDeploymentOperationId ? { restoredDeploymentOperationId } : {}),
      ...(request.existingDeploymentOperationId ? { existingDeploymentOperationId: request.existingDeploymentOperationId } : {}),
      ...(attribution ? { requesterWorkAttributionV1: attribution } : {}),
      ...(requestId ? { requestId } : {}),
      ...(carriesNativeConfirmation(request.actionId, request.rpcContext) ? { rejoinPendingApproval: true as const } : {}),
      ...(request.rpcContext?.approvedActionReplay ? { approvedActionReplay: request.rpcContext.approvedActionReplay } : {}),
      input: operationInput,
      ...(deploymentChildIdentity ? { deploymentChildIdentity } : {}),
      ...(deploymentTokenOrigin ? { deploymentTokenOrigin } : {}),
      onOperation: operation => {
        observedOperationId = operation.operationId;
        if (teardown?.success && 'contentArtifactId' in teardown.data) store.retainTeardownExecution(scope, operation.operationId,
          { execute: request.execute, ...(request.resume ? { resume: request.resume } : {}) });
        request.onOperation?.(operation);
      },
      ...(domainRef ? { domainRef } : {}),
      cancellation: request.actionId === 'workspace.files.replace'
        || request.actionId === 'projects.script.run' || request.actionId === 'projects.compute.exec' || request.actionId === 'projects.prepare'
        || request.actionId === 'machines.managed.power.set' || request.actionId === 'machines.managed.delete'
        || request.actionId === 'machines.managed.acquire' || request.actionId === 'machines.managed.bootstrap.retry'
        || request.actionId === 'machines.setup.apply' || request.actionId === 'machines.setup.adminAccess.set' || request.actionId === 'machines.reboot'
        || request.actionId === 'machines.services.exec'
        || request.actionId === 'deployments.backups.restore'
        || (request.rpcContext?.externalActionExecutionAuthorization
          ? request.rpcContext.externalActionExecutionAuthorization.binding.deploymentChildRoot === true
          : isDeploymentChildEffectActionIdV1(request.actionId))
        || (cancellableActionId && deps.supportsCoreCancellation?.(cancellableActionId, request.input) === true)
        ? 'supported'
        : 'unsupported',
      execute: async ({ actionRequestId, resumeActionRequest, signal, updateProgress, publishOwnerUpdate, operationAcceptance, onCancellationRequested, requesterWorkAttributionV1, operationReview, afterTerminalSuccessAcknowledged }) => {
        const execute = resumeActionRequest && retainedTeardown
          ? retainedTeardown.resume ?? retainedTeardown.execute : request.execute;
        const result = await execute({
          ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
          // Receipt correspondence is not a replacement for original-root correlation.
          ...(deploymentRequestId ? !retainedTeardown && request.actionRequestId ? { actionRequestId: request.actionRequestId } : {}
            : actionRequestId ? { actionRequestId } : {}),
          ...(resumeActionRequest ? { resumeActionRequest } : {}),
          signal,
          operationProgress: { update: updateProgress },
          operationOwnerUpdate: { update: publishOwnerUpdate },
          operationCancellation: { onRequest: onCancellationRequested },
          operationReview,
          ...(afterTerminalSuccessAcknowledged ? { afterTerminalSuccessAcknowledged } : {}),
          ...(settleManagedNativeOperation ? { settleManagedNativeOperation } : {}),
          ...(operationAcceptance ? { operationAcceptance } : {}),
        });
        const serverId = deps.custodyBinding?.serverId ?? deps.serverId;
        if (isDeploymentDomainChildActionIdV1(request.actionId) && !result.ok && serverId && observedOperationId) {
          const input = DeploymentActionInputSchemasV1[request.actionId].safeParse(request.input);
          if (input.success) {
            const native = { environmentId: input.data.environmentId, domainId: input.data.domainId,
              step: 'native_execution' as const };
            const details = DeploymentDomainFailureDetailsV1Schema.safeParse({ ...native,
              ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {}) });
            const diagnostic = details.success && details.data.environmentId === input.data.environmentId
              && details.data.domainId === input.data.domainId ? details.data : native;
            // The runner stores this same bound result before live/public consumers read it.
            return { ...result, details: { ...projectDeploymentFailureRecoveryV1(diagnostic),
              operation: { serverId, machineId: scope.machineId, operationId: observedOperationId } } };
          }
        }
        return result;
      },
    }).catch((error: unknown): ActionExecuteResult => {
      if (!(error instanceof ProjectOpenReceiptPersistenceError)) throw error;
      return { ok: false, errorCode: error.effectAttempted ? 'action_outcome_unknown' : 'action_not_admitted',
        error: error.message, effectAttempted: error.effectAttempted };
    });
    // The keyed Session startup remains daemon-owned after its caller leaves.
    // Detach only this transport waiter; a retry can rejoin the same execution.
    const result = await (request.actionId === 'session.spawn_new'
      ? observeUntilCallerAbort(execution, request.rpcContext?.signal)
      : execution);
    const serverId = deps.custodyBinding?.serverId ?? deps.serverId;
    if (request.actionId === 'session.spawn_new' && result.ok && serverId && observedOperationId) {
      const pending = SessionSpawnNewActionResultV1Schema.safeParse(result.result);
      if (pending.success && pending.data.type === 'pending') {
        return { ...result, result: { ...pending.data,
          operation: { serverId, machineId: scope.machineId, operationId: observedOperationId } } };
      }
    }
    if (request.actionId === 'deployments.deploy' && result.ok && serverId && observedOperationId) {
      const pending = DeploymentReceiptResultV1Schema.safeParse(result.result);
      if (pending.success && pending.data.ok && 'kind' in pending.data && pending.data.kind === 'pending'
        && pending.data.actionOperationId === observedOperationId) {
        return { ...result, result: { ...pending.data,
          operation: { serverId, machineId: scope.machineId, operationId: observedOperationId } } };
      }
    }
    return result;
  };

  const runActionOperation = async (request: Parameters<NonNullable<ActionExecutorDeps['runActionOperation']>>[0]
    & Readonly<{ recoverPendingDeployment?: () => Promise<import('@happier-dev/protocol/deployments/deploymentActionsV1').DeploymentPendingAdmissionV1 | undefined> }>) => {
    return runHostActionOperation(observeExecution, request);
  };

  /** Prepares observation, not execution or a new request identity. The original
   * prepared input never leaves the private runtime/domain validator corridor. */
  const preparePendingDeploymentObservation = async (request: PendingDeploymentObservationRequest) => {
    const context: RpcActionExecutorContext = request.context;
    const scope = await resolveObservedScope(context, context.defaultSessionId ?? undefined);
    const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
    const binding = context.externalActionExecutionAuthorization?.binding;
    const admission = request.admission;
    if (!scope || !binding || !requester || !await requester.isCurrent() || context.signal?.aborted
      || binding.actionId !== 'deployments.deploy' || !deps.custodyBinding
      || binding.accountId !== scope.accountId || admission.requesterAccountId !== scope.accountId
      || binding.machineId !== scope.machineId || admission.controller.machineId !== scope.machineId
      || binding.installationId !== deps.custodyBinding.installationId
      || admission.controller.installationId !== deps.custodyBinding.installationId
      || admission.serverId !== binding.serverIdentityId
      || !await isServerProfileHomeIdentity(deps.custodyBinding.serverId, binding.serverIdentityId)
      || admission.requestKey !== request.input.requestKey) throw new RpcError('action_forbidden', 'action_forbidden');
    const requestId = readDeploymentOperationRequestId('deployments.deploy', request.input);
    const existing = requestId ? store.findByRequestIdentity(scope, 'deployments.deploy', requestId) : null;
    if (!existing) return undefined;
    if (existing.operationId !== admission.actionOperationId) throw new RpcError('deployment_conflict', 'deployment_conflict');
    const childIdentity = await readDeploymentArchiveOperationIdentityForHost(context, 'deployments.deploy');
    const tokenOrigin = readDeploymentTokenOperationOrigin({ actionId: 'deployments.deploy', scope, context,
      environmentId: request.input.environmentId });
    if (!store.hasMatchingDeploymentChildIdentity(existing.operationId, childIdentity)
      || !store.hasMatchingDeploymentTokenOrigin(existing.operationId, tokenOrigin)) {
      throw new RpcError('action_request_input_conflict', 'action_request_input_conflict');
    }
    const original = DeploymentDeployInputV1Schema.safeParse(store.readDeploymentInvocationInput(scope, existing.operationId));
    if (!original.success || original.data.serverId !== request.input.serverId
      || original.data.environmentId !== request.input.environmentId || original.data.requestKey !== request.input.requestKey
      || request.input.targetLinkId !== undefined && original.data.targetLinkId !== request.input.targetLinkId
      || original.data.pendingDeploy && !isDeepStrictEqual(original.data.pendingDeploy, request.pendingDeploy)) {
      throw new RpcError('deployment_conflict', 'deployment_conflict');
    }
    await request.validateOriginalInput(original.data, context);
    return async (currentContext: import('@happier-dev/protocol').ActionExecutorContext): Promise<ActionExecuteResult> => {
      await request.validateOriginalInput(original.data, currentContext);
      return observeExecution({ actionId: 'deployments.deploy', input: original.data,
        rpcContext: currentContext, existingDeploymentOperationId: existing.operationId,
        ...(currentContext.actionRequestId ? { actionRequestId: currentContext.actionRequestId } : {}),
        ...(currentContext.defaultSessionId ? { sessionId: currentContext.defaultSessionId } : {}),
        execute: async () => ({ ok: false, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' }),
      });
    };
  };

  const observePluginExecution = async (request: Readonly<{
    actionId: string;
    title: string;
    operation: ActionOperationDeclarationV1;
    input: unknown;
    failureResult?: Parameters<typeof runner.observe>[0]['failureResult'];
    requestId?: string;
    sessionId?: string;
    rpcContext?: ActionOperationRpcContext & Pick<RpcActionExecutorContext, 'externalActionExecutionAuthorization'>;
    execute: (context: Readonly<{
      signal: AbortSignal;
      operationProgress: Readonly<{ update: (update: ActionOperationProgressUpdate) => void }>;
      operationAcceptance?: import('@happier-dev/protocol').ActionExecutorContext['operationAcceptance'];
      operationOwnerUpdate?: import('@happier-dev/protocol').ActionExecutorContext['operationOwnerUpdate'];
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const scope = await resolveObservedScope(request.rpcContext, request.sessionId);
    if (!scope) {
      return await request.execute({
        signal: new AbortController().signal,
        operationProgress: { update: () => undefined },
      });
    }
    const attribution = acceptedAttribution(scope, request.rpcContext);
    return await runner.observe({
      actionId: request.actionId,
      action: {
        actionId: request.actionId,
        title: request.title,
        operation: request.operation,
      },
      scope,
      ...(attribution ? { requesterWorkAttributionV1: attribution } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}),
      input: request.input,
      ...(request.failureResult ? { failureResult: request.failureResult } : {}),
      execute: async ({ signal, updateProgress, operationAcceptance, publishOwnerUpdate }) => await request.execute({
        signal,
        operationProgress: { update: updateProgress },
        operationAcceptance,
        operationOwnerUpdate: { update: publishOwnerUpdate },
      }),
    });
  };

  const attachOwner = (next: ActionOperationDomainOwner): (() => void) => {
    if (attachedOwners.has(next)) throw new Error('action_operation_domain_owner_already_attached');
    attachedOwners.add(next);
    rebuildOwner();
    const unsubscribe = next.subscribe({
      resolveScope: async () => {
        const accountId = await deps.resolveAccountId();
        return accountId ? { accountId, machineId: deps.machineId } : null;
      },
      publishSnapshot: snapshot => { if (attachedOwners.has(next)) store.project(snapshot); },
    });
    return () => {
      unsubscribe();
      if (attachedOwners.delete(next)) {
        rebuildOwner();
        store.removeOwnerProjections(next.actionIds.filter(id => !owner?.actionIds.includes(id)));
      }
    };
  };
  const decideSetupReview: typeof runner.decideSetupReview = async (scope, id, workspace, phase, decision) => {
    const current = owner;
    const retained = store.get(scope, id);
    if (current && (!retained || current.actionIds.includes(retained.actionId))) {
      const projected = await current.get(scope, id);
      if (current !== owner) return null;
      if (projected) {
        const result = await current.decideSetupReview?.(scope, id, workspace, phase, decision) ?? null;
        if (current !== owner) return null;
        if (result) store.project(result);
        return result;
      }
    }
    return await runner.decideSetupReview(scope, id, workspace, phase, decision);
  };
  const activity: LiveWorkProducerV1 = Object.freeze({ read: store.readLiveWork, subscribe: store.subscribe });
  return Object.freeze({ store, runner, handlers, observeExecution, runActionOperation, observePluginExecution, attachOwner, activity,
    preparePendingDeploymentObservation,
    /** Restore evidence stays under the same requester/Machine custody as its
     * existing Action operation; another Account cannot select it by ID. */
    async readRestorePreparation(request: Readonly<{ operationId: string; context?: ActionOperationRpcContext }>) {
      const scope = await resolveObservedScope(request.context);
      return scope ? store.get(scope, request.operationId) : null;
    },
    async readDeploymentBackupOperations(request: Readonly<{
      target: DeploymentBackupOperationTarget; context?: ActionOperationRpcContext;
    }>) {
      const scope = await resolveObservedScope(request.context);
      return scope ? store.readDeploymentBackupOperations(scope, request.target) : [];
    },
    /** Await the incumbent Account-mode publisher before an irreversible
     * boundary can destroy this daemon's only copy of the admitted snapshot. */
    async publishCurrentSnapshot(scope: Parameters<typeof store.get>[0], operationId: string): Promise<void> {
      const snapshot = store.get(scope, operationId);
      if (snapshot) await deps.publishSnapshot?.(snapshot);
    },
    decideSetupReview,
    retireProjectFiniteOperations: runner.retireProjectFiniteOperations,
    waitForProjectTerminalAttachment: runner.waitForProjectTerminalAttachment });
}

export type HostActionOperationRuntime = ReturnType<typeof createHostActionOperationRuntime>;

/** All receiving hosts adapt admitted effects to the same runner and requester lifetime. */
export async function runHostActionOperation(
  observeExecution: HostActionOperationRuntime['observeExecution'],
  request: Parameters<NonNullable<ActionExecutorDeps['runActionOperation']>>[0]
    & Readonly<{ recoverPendingDeployment?: () => Promise<import('@happier-dev/protocol/deployments/deploymentActionsV1').DeploymentPendingAdmissionV1 | undefined> }>,
  rpcContext?: ActionOperationRpcContext,
): Promise<ActionExecuteResult> {
  const context: RpcActionExecutorContext = request.context;
  // The finite Project owner reviews placement before creating its operation.
  // Wrapping it here accepts refused work and loses its retained setup review.
  if (Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, request.actionId)) return request.execute(context);
  // Ordinary Open relays still observe at the native receiver. Installed
  // carried confirmation observes here before policy; the receiver consumes
  // that same private acceptance rather than joining its own invocation.
  if ((request.actionId === 'projects.open' || request.actionId === 'localServices.launcher.start')
    && !carriesNativeConfirmation(request.actionId, context)) return request.execute(context);
  if (context.operationAcceptance?.actionId === request.actionId) return request.execute(context);
  const resume = request.resume;
  return observeExecution({ actionId: request.actionId, input: request.input, rpcContext: rpcContext ?? context,
    ...(request.resumeRetained ? { resumeRetained: true as const } : {}),
    ...(resume ? { resume: (operation: Parameters<HostActionOperationExecute>[0]) => resume({ ...context, ...operation }) } : {}),
    ...(request.recoverPendingDeployment ? { recoverPendingDeployment: request.recoverPendingDeployment } : {}),
    ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
    ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
    execute: async operation => {
      // The effect owns its lifetime after admission, including the private
      // requester ports needed to publish its real terminal fact.
      const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
      const retained = await requester?.retainForOperation?.(operation.signal);
      const release = retained ? undefined : requester?.retain();
      // Observation attributes every operation, including a person's click.
      // That stored attribution is not new Agent provenance for the invocation.
      // Preserve only attribution already carried by its admitted Action context.
      const { requesterWorkAttributionV1: _observedAttribution, ...operationContext } = operation;
      try { return await request.execute({ ...context, ...operationContext,
        ...(retained ? { externalActionExecutionAuthorization: retained.authorization } : {}) }); }
      finally { if (retained) await retained.dispose(); else await release?.(); }
    },
  });
}
