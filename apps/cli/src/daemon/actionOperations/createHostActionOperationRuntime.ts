import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionOperationDomainRefV1, ActionOperationSnapshotV1, ActionOperationDeclarationV1 } from '@happier-dev/protocol/actions';

import { createActionOperationRpcHandlers, resolveActionOperationScope, type ActionOperationRpcContext } from './actionOperationRpcHandlers';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import type { ActionOperationDomainOwner, ActionOperationProgressUpdate } from './actionOperationTypes';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { RpcError, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import type { LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';

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

export function createHostActionOperationRuntime(deps: Readonly<{
  /** Exact configured Home binding, shared with the incumbent Session launch owner. */
  serverId?: string;
  machineId: string;
  /** Captured by the actual installed Machine client, never an Action input. */
  custodyBinding?: Readonly<{ serverId: string; installationId: string }>;
  resolveAccountId: () => Promise<string | null>;
  generateOperationId?: () => string;
  publishSnapshot?: (snapshot: ActionOperationSnapshotV1) => void;
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
        ? { actionId: spec.id, title: spec.title, operation: spec.operation }
        : null;
    },
    ...(deps.generateOperationId ? { generateOperationId: deps.generateOperationId } : {}),
  });
  let owner: ActionOperationDomainOwner | null = null;
  const acceptedAttribution = (scope: Readonly<{ accountId: string; machineId: string }>, context?: ActionOperationRpcContext) =>
    (deps.custodyBinding?.serverId ?? deps.serverId) && context?.machineAdmission
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
    if (admission && ((!deps.custodyBinding && admission.actorAccountId !== admission.custodianAccountId)
      || (deps.custodyBinding && admission.installationId !== deps.custodyBinding.installationId))) {
      throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
    }
    return await resolveActionOperationScope(deps, context, sessionId);
  };

  const observeExecution = async (request: Readonly<{
    actionId: string;
    input: unknown;
    actionRequestId?: string;
    sessionId?: string;
    /** Already admitted receiving-host context, never a public Action input. */
    rpcContext?: ActionOperationRpcContext;
    execute: (context: Readonly<{
      actionRequestId?: string;
      resumeActionRequest?: true;
      signal: AbortSignal;
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      operationProgress: Readonly<{ update: (update: ActionOperationProgressUpdate) => void }>;
      operationOwnerUpdate: Readonly<{ update: (update: import('./actionOperationTypes').ActionOperationOwnerUpdate) => void }>;
      operationAcceptance?: import('@happier-dev/protocol').ActionExecutorContext['operationAcceptance'];
      operationCancellation?: import('@happier-dev/protocol').ActionExecutorContext['operationCancellation'];
      operationReview?: import('./actionOperationTypes').ActionOperationReviewContinuation;
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const scope = await resolveObservedScope(request.rpcContext, request.sessionId);
    const actionId = ActionIdSchema.safeParse(request.actionId);
    const spec = actionId.success ? getActionSpec(actionId.data) : null;
    if (!scope || !spec?.operation) {
      return await request.execute({
        signal: new AbortController().signal,
        operationProgress: { update: () => undefined },
        operationOwnerUpdate: { update: () => undefined },
      });
    }
    const attribution = acceptedAttribution(scope, request.rpcContext);
    const cancellableActionId = request.actionId === 'session.fork'
      || request.actionId === 'session.spawn_new'
      || request.actionId === 'session.handoff'
      || request.actionId === 'projects.service.relocate'
      ? request.actionId
      : null;
    const requestId = request.actionRequestId?.trim()
      || readRequestId(request.actionId, request.input);
    const domainRef = readInitialDomainRef(request.actionId, request.input, requestId);
    return await runner.observe({
      actionId: request.actionId,
      scope,
      ...(attribution ? { requesterWorkAttributionV1: attribution } : {}),
      ...(requestId ? { requestId } : {}),
      input: request.input,
      ...(domainRef ? { domainRef } : {}),
      cancellation: request.actionId === 'projects.script.run' || request.actionId === 'projects.compute.exec' || request.actionId === 'projects.prepare'
        || request.actionId === 'machines.managed.power.set' || request.actionId === 'machines.managed.delete'
        || request.actionId === 'machines.managed.acquire' || request.actionId === 'machines.managed.bootstrap.retry'
        || request.actionId === 'machines.environment.apply'
        || (cancellableActionId && deps.supportsCoreCancellation?.(cancellableActionId, request.input) === true)
        ? 'supported'
        : 'unsupported',
      execute: async ({ actionRequestId, resumeActionRequest, signal, updateProgress, publishOwnerUpdate, operationAcceptance, onCancellationRequested, requesterWorkAttributionV1, operationReview }) => await request.execute({
        ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
        ...(actionRequestId ? { actionRequestId } : {}),
        ...(resumeActionRequest ? { resumeActionRequest } : {}),
        signal,
        operationProgress: { update: updateProgress },
        operationOwnerUpdate: { update: publishOwnerUpdate },
        operationCancellation: { onRequest: onCancellationRequested },
        operationReview,
        ...(operationAcceptance ? { operationAcceptance } : {}),
      }),
    });
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
    if (owner) throw new Error('action_operation_domain_owner_already_attached');
    owner = next;
    const unsubscribe = next.subscribe({
      resolveScope: async () => {
        const accountId = await deps.resolveAccountId();
        return accountId ? { accountId, machineId: deps.machineId } : null;
      },
      publishSnapshot: store.project,
    });
    return () => {
      unsubscribe();
      if (owner === next) {
        owner = null;
        store.removeOwnerProjections(next.actionIds);
      }
    };
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
  return Object.freeze({ store, runner, handlers, observeExecution, observePluginExecution, attachOwner, activity,
    retireProjectFiniteOperations: runner.retireProjectFiniteOperations,
    cleanupRequesterMachineOperations,
    waitForProjectTerminalAttachment: runner.waitForProjectTerminalAttachment });
}

export type HostActionOperationRuntime = ReturnType<typeof createHostActionOperationRuntime>;
