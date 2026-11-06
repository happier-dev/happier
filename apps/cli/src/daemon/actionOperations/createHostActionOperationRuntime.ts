import { MachineServiceAdoptInputV1Schema } from '@happier-dev/protocol/local/services/adoptionV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { type DeploymentPendingAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionOperationCancellation } from './actionOperationTypes';
import type { ManagedMachineOperationSettlementContext } from '@/machines/managed/managedIntentReconciler';
import { readDeploymentArchiveOperationIdentityForHost } from '@/deployments/targets/ownServer/archiveFilesystemAdmission';
import type { ManagedDeleteOperationSettlement } from '@/machines/managed/managedIntentReconciler';
import { isDeepStrictEqual } from 'node:util';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTokenOperationOrigin } from './deploymentTokenOrigin';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { isDeploymentChildRootActionIdV1 } from '@happier-dev/protocol';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { DeploymentReceiptResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { type DeploymentDeployIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { type DeploymentDeployInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionExecuteResult, ActionExecutorDeps, ActionOperationDomainRefV1, ActionOperationSnapshotV1, ActionOperationDeclarationV1 } from '@happier-dev/protocol/actions';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";

import { createActionOperationRpcHandlers, resolveActionOperationScope, type ActionOperationRpcContext } from './actionOperationRpcHandlers';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import type { ActionOperationDomainOwner, ActionOperationProgressUpdate } from './actionOperationTypes';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { RpcError, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import type { LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

export type RequesterMachineOperationCleanupInput = Readonly<{
  serverId: string;
  requesterAccountId: string;
  machineId: string;
  installationId: string;
  verifyCurrentMachineAdmission: () => Promise<boolean>;
}>;

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
  publishSnapshot?: (snapshot: ActionOperationSnapshotV1) => void;
  publishSnapshotAcknowledged?: (snapshot: ActionOperationSnapshotV1) => Promise<boolean>;
  onInspection?: (operation: ActionOperationSnapshotV1) => void;
  supportsCoreCancellation?: (
    actionId: 'session.fork' | 'session.spawn_new' | 'session.handoff' | 'projects.service.relocate',
    input: unknown,
  ) => boolean;
}>) {
  const store = createActionOperationStore({
    ...(deps.publishSnapshot ? { onSnapshot: deps.publishSnapshot } : {}),
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
      async cancel(scope, id) { return (await find(scope, id))?.item.cancel(scope, id) ?? null; },
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
    execute: (context: Readonly<{
      actionRequestId?: string;
      resumeActionRequest?: true;
      signal: AbortSignal;
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      operationProgress: Readonly<{ update: (update: ActionOperationProgressUpdate) => void }>;
      operationOwnerUpdate: Readonly<{ update: (update: import('./actionOperationTypes').ActionOperationOwnerUpdate) => void }>;
      operationAcceptance?: import('@happier-dev/protocol').ActionExecutorContext['operationAcceptance'];
      operationCancellation?: ActionOperationCancellation;
      operationReview?: import('./actionOperationTypes').ActionOperationReviewContinuation;
      afterTerminalSuccessAcknowledged?: (effect: () => Promise<void>) => void;
      settleManagedDeleteOperation?: ManagedMachineOperationSettlementContext['settleManagedDeleteOperation'];
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const scope = await resolveObservedScope(request.rpcContext, request.sessionId);
    const deploymentChildIdentity = await readDeploymentArchiveOperationIdentityForHost(request.rpcContext, request.actionId);
    const settleManagedDeleteOperation = scope
      && (request.actionId === 'machines.managed.inspect' || request.actionId === 'machines.managed.delete')
      ? (settlement: ManagedDeleteOperationSettlement) => {
        if (settlement.controller && (settlement.controller.machineId !== deps.machineId
          || deps.custodyBinding && settlement.controller.installationId !== deps.custodyBinding.installationId)) return;
        // Confirmed native absence ends setup for this same managed Machine.
        // Reuse each admitted invocation's local cancellation owner, including
        // early acquisition phases that have not yet acquired a resource.
        const acquisitionScope = { accountId: scope.accountId, machineId: scope.machineId };
        for (const candidate of store.list({ ...acquisitionScope, states: ['accepted', 'running'] }).items) {
          const acquiring = candidate.domainRef;
          if ((candidate.actionId === 'machines.managed.acquire' || candidate.actionId === 'machines.managed.bootstrap.retry')
            && acquiring?.kind === 'managedMachine' && acquiring.id === settlement.managedId
            && (!acquiring.controller || isDeepStrictEqual(acquiring.controller, settlement.controller))
            && (!acquiring.resource || isDeepStrictEqual(acquiring.resource, settlement.resource))) {
            runner.cancel(acquisitionScope, candidate.operationId);
          }
        }
        const operation = store.findByRequestIdentity(scope, 'machines.managed.delete', settlement.requestId);
        const target = operation?.domainRef;
        // Only the retained uncertain invocation is retired. A running native
        // handler, another resource/controller, or terminal history is untouched.
        if (!operation || operation.state !== 'running' || operation.observation?.kind !== 'outcome_uncertain'
          || operation.observation.code !== 'action_outcome_unknown' || target?.kind !== 'managedMachine'
          || target.id !== settlement.managedId || !isDeepStrictEqual(target.controller, settlement.controller)
          || !isDeepStrictEqual(target.resource, settlement.resource)) return;
        store.succeed(operation.operationId, { kind: 'accepted', managedId: settlement.managedId,
          intentRevision: settlement.intentRevision, operation: { operationId: operation.operationId } });
      } : undefined;
    const actionId = ActionIdSchema.safeParse(request.actionId);
    const spec = actionId.success ? getActionSpec(actionId.data) : null;
    const template = request.actionId === 'deployments.templates.instantiate'
      ? DeploymentActionInputSchemasV1['deployments.templates.instantiate'].safeParse(request.input) : null;
    if (!scope || !spec || !(request.operation ?? spec.operation) || template?.success && template.data.mode === 'preview') {
      if (carriesNativeConfirmation(request.rpcContext)) return { ok: false,
        errorCode: 'admission_unavailable', error: 'admission_unavailable' };
      return await request.execute({
        signal: new AbortController().signal,
        operationProgress: { update: () => undefined },
        operationOwnerUpdate: { update: () => undefined },
        ...(settleManagedDeleteOperation ? { settleManagedDeleteOperation } : {}),
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
    let observedOperationId: string | undefined;
    const execution = runner.observe({
      actionId: request.actionId,
      ...(request.operation ? { action: { actionId: spec.id,
        title: spec.title, operation: request.operation } } : {}),
      scope,
      ...(restoredDeploymentOperationId ? { restoredDeploymentOperationId } : {}),
      ...(request.existingDeploymentOperationId ? { existingDeploymentOperationId: request.existingDeploymentOperationId } : {}),
      ...(attribution ? { requesterWorkAttributionV1: attribution } : {}),
      ...(requestId ? { requestId } : {}),
      ...(carriesNativeConfirmation(request.rpcContext) ? { rejoinPendingApproval: true as const } : {}),
      ...(request.rpcContext?.approvedActionReplay ? { approvedActionReplay: request.rpcContext.approvedActionReplay } : {}),
      input: request.input,
      ...(deploymentChildIdentity ? { deploymentChildIdentity } : {}),
      ...(deploymentTokenOrigin ? { deploymentTokenOrigin } : {}),
      onOperation: operation => { observedOperationId = operation.operationId; request.onOperation?.(operation); },
      ...(domainRef ? { domainRef } : {}),
      cancellation: request.actionId === 'workspace.files.replace'
        || request.actionId === 'projects.script.run' || request.actionId === 'projects.compute.exec' || request.actionId === 'projects.prepare'
        || request.actionId === 'machines.managed.power.set' || request.actionId === 'machines.managed.delete'
        || request.actionId === 'machines.managed.acquire' || request.actionId === 'machines.managed.bootstrap.retry'
        || request.actionId === 'machines.setup.apply' || request.actionId === 'machines.setup.adminAccess.set' || request.actionId === 'machines.reboot'
        || request.actionId === 'machines.services.exec'
        || isDeploymentChildRootActionIdV1(request.actionId)
        || (cancellableActionId && deps.supportsCoreCancellation?.(cancellableActionId, request.input) === true)
        ? 'supported'
        : 'unsupported',
      execute: async ({ actionRequestId, resumeActionRequest, signal, updateProgress, publishOwnerUpdate, operationAcceptance, onCancellationRequested, requesterWorkAttributionV1, operationReview, afterTerminalSuccessAcknowledged }) => await request.execute({
        ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
        // Receipt correspondence is not a replacement for original-root correlation.
        ...(deploymentRequestId ? request.actionRequestId ? { actionRequestId: request.actionRequestId } : {}
          : actionRequestId ? { actionRequestId } : {}),
        ...(resumeActionRequest ? { resumeActionRequest } : {}),
        signal,
        operationProgress: { update: updateProgress },
        operationOwnerUpdate: { update: publishOwnerUpdate },
        operationCancellation: { onRequest: onCancellationRequested },
        operationReview,
        ...(afterTerminalSuccessAcknowledged ? { afterTerminalSuccessAcknowledged } : {}),
        ...(settleManagedDeleteOperation ? { settleManagedDeleteOperation } : {}),
        ...(operationAcceptance ? { operationAcceptance } : {}),
      }),
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

  const runActionOperation: NonNullable<ActionExecutorDeps['runActionOperation']> = async request => {
    return runHostActionOperation(observeExecution, request);
  };

  const observePluginExecution = async (request: Readonly<{
    actionId: string;
    title: string;
    operation: ActionOperationDeclarationV1;
    input: unknown;
    requestId?: string;
    sessionId?: string;
    rpcContext?: ActionOperationRpcContext;
    execute: (context: Readonly<{
      signal: AbortSignal;
      operationProgress: Readonly<{ update: (update: ActionOperationProgressUpdate) => void }>;
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
      execute: async ({ signal, updateProgress }) => await request.execute({
        signal,
        operationProgress: { update: updateProgress },
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
  const cleanupRequesterMachineOperations = async (input: RequesterMachineOperationCleanupInput): Promise<Readonly<{ kind: 'settled' | 'incomplete' }>> => {
    if (!deps.custodyBinding || input.machineId !== deps.machineId
      || input.serverId !== deps.custodyBinding.serverId || input.installationId !== deps.custodyBinding.installationId) {
      return { kind: 'incomplete' };
    }
    try {
      if (!await input.verifyCurrentMachineAdmission()) return { kind: 'incomplete' };
      const scope = { accountId: input.requesterAccountId, machineId: deps.machineId };
      const requests = await runner.cancelForAccessLoss(scope, input.verifyCurrentMachineAdmission, {
        serverId: input.serverId, accountId: input.requesterAccountId,
        machineId: input.machineId, installationId: input.installationId,
      });
      let incomplete = false;
      for (const request of requests) {
        if (request.result.kind === 'unsupported' || request.result.kind === 'not_found' || request.result.kind === 'admission_not_current') {
          incomplete = true;
          continue;
        }
        const settled = await runner.waitForTerminal(scope, request.operationId);
        if (!settled || settled.state === 'accepted' || settled.state === 'running') incomplete = true;
      }
      return { kind: incomplete ? 'incomplete' : 'settled' };
    } catch { return { kind: 'incomplete' }; }
  };
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
return Object.freeze({async publishCurrentSnapshot(scope: Parameters<typeof store.get>[0], operationId: string): Promise<void> {
      const snapshot = store.get(scope, operationId);
      if (snapshot) await deps.publishSnapshot?.(snapshot);
    },
preparePendingDeploymentObservation,
    /** Restore evidence stays under the same requester/Machine custody as its
     * existing Action operation; another Account cannot select it by ID. */
    async readRestorePreparation(request: Readonly<{ operationId: string; context?: ActionOperationRpcContext }>) {
      const scope = await resolveObservedScope(request.context);
      return scope ? store.get(scope, request.operationId) : null;
    },
 store, runner, handlers, observeExecution, runActionOperation, observePluginExecution, attachOwner, activity,
    decideSetupReview,
    retireProjectFiniteOperations: runner.retireProjectFiniteOperations,
    cleanupRequesterMachineOperations,
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
    && !carriesNativeConfirmation(context)) return request.execute(context);
  if (context.operationAcceptance?.actionId === request.actionId) return request.execute(context);
  return observeExecution({ actionId: request.actionId, input: request.input, rpcContext: rpcContext ?? context,
    ...(request.recoverPendingDeployment ? { recoverPendingDeployment: request.recoverPendingDeployment } : {}),
    ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
    ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
    execute: async operation => {
      // Acceptance may return before transfer/process settlement. Retain the
      // original requester's private ports until the effect actually finishes.
      const release = readRequesterAccountActionContext(context.externalActionExecutionAuthorization)?.retain();
      // Observation attributes every operation, including a person's click.
      // That stored attribution is not new Agent provenance for the invocation.
      // Preserve only attribution already carried by its admitted Action context.
      const { requesterWorkAttributionV1: _observedAttribution, ...operationContext } = operation;
      try { return await request.execute({ ...context, ...operationContext }); }
      finally { await release?.(); }
    },
  });
}

type ConfirmationContext = Pick<ActionExecutorContext, 'presentUserConfirmation' | 'externalActionExecutionAuthorization' | 'approvedActionReplay'>;

function carriesNativeConfirmation(context?: ConfirmationContext): boolean {
  return Boolean(context?.externalActionExecutionAuthorization && context.presentUserConfirmation?.inputDigest);
}

function readDeploymentOperationRequestId(actionId: string, input: unknown): string | undefined {
  if (actionId === 'machines.services.adopt') {
    const parsed = MachineServiceAdoptInputV1Schema.safeParse(input);
    if (!parsed.success || parsed.data.mode !== 'apply') return undefined;
    return computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
      'adopt', parsed.data.serverId, parsed.data.machineId, parsed.data.serviceId, parsed.data.requestKey,
    ]);
  }
  if (actionId === 'deployments.backups.restore') {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success || parsed.data.mode !== 'confirm') return undefined;
    // One prepared restore can enter the destructive native phase once. The
    // incumbent runner compares the complete input before returning its result.
    return computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
      'restore', parsed.data.prepareOperationId,
    ]);
  }
  if (actionId === 'deployments.templates.instantiate') {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success || parsed.data.mode !== 'apply' || parsed.data.environment.kind !== 'create') return undefined;
    return computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
      // The parsed template requires exactly one existing Source or new Project.
      'template', parsed.data.serverId, parsed.data.projectSourceId ?? parsed.data.newProject!.requestKey, parsed.data.machineId,
      parsed.data.target.installationId, parsed.data.environment.requestKey,
    ]);
  }
  if (!isDeploymentChildRootActionIdV1(actionId) && actionId !== 'deployments.teardown') return undefined;
  const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
  if (!parsed.success || !('requestKey' in parsed.data) || parsed.data.requestKey === undefined) return undefined;
  return computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
    parsed.data.serverId, parsed.data.environmentId, parsed.data.requestKey,
  ]);
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
