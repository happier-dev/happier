import { ActionOperationCancelV1RequestSchema, ActionOperationCancelV1ResponseSchema, ActionOperationGetV1RequestSchema, ActionOperationGetV2RequestSchema, ActionOperationGetV1ResponseSchema, ActionOperationListV1RequestSchema, ActionOperationListV2RequestSchema, ActionOperationListV1ResponseSchema, ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionOperationListV2Request } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionOperationCancelV1Response, ActionOperationGetV1Response, ActionOperationListV1Response, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RpcError, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import type { ActionOperationRunner } from './actionOperationRunner';
import type { ActionOperationStore } from './actionOperationStore';
import type { ActionOperationCancellationContext, ActionOperationDomainOwner, ActionOperationScope } from './actionOperationTypes';
import { ProjectServiceMoveStartClaimV1Schema, ProjectServiceMoveStartClaimResultV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readDeploymentArchiveOperationIdentityForHost } from '@/deployments/targets/ownServer/archiveFilesystemAdmission';
import { readDeploymentTokenOperationOrigin } from './deploymentTokenOrigin';
import { readReviewedActionOperationCancelAddress } from '@/api/externalActionExecutionAuthorization';

export type ActionOperationRpcContext = Readonly<Partial<Pick<RpcHandlerContext,
  'signal' | 'machineAdmission' | 'verifyMachineAdmissionCurrent' | 'requesterSessionBootstrap'
  | 'callerInputAuthorization' | 'workspaceSyncSourceExecution' | 'originalActionEnvelope' | 'callerAuthority' | 'callerInputConstraints'>>>;

/** Admission is transport-owned; no Action input can select the owning Account. */
export async function resolveActionOperationScope(
  deps: Readonly<{ machineId: string; resolveAccountId: () => Promise<string | null> }>,
  context?: ActionOperationRpcContext,
  sessionId?: string,
): Promise<ActionOperationScope | null> {
  const admission = context?.machineAdmission;
  const session = !admission ? context?.requesterSessionBootstrap : undefined;
  if (session && (session.attribution.machineId !== deps.machineId || context?.signal?.aborted
    || !await session.isCurrent() || context?.signal?.aborted)) {
    throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
  }
  if (admission && (admission.machineId !== deps.machineId || context?.signal?.aborted)) {
    throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
  }
  // Current foreign Machine routing always carries verified admission. Retained
  // owned predecessor routing and in-process callers keep their local Account.
  const accountId = admission?.actorAccountId ?? session?.attribution.accountId ?? await deps.resolveAccountId();
  return accountId ? { accountId, machineId: deps.machineId, ...(sessionId ? { sessionId } : {}) } : null;
}

export function createActionOperationRpcHandlers(deps: Readonly<{
  store: ActionOperationStore;
  runner: Pick<ActionOperationRunner, 'requestCancellation'> & Partial<Pick<ActionOperationRunner, 'waitForTerminal' | 'refreshSetupReview' | 'claimServiceMoveStart' | 'reconcileSessionBirth'>>;
  owner?: () => ActionOperationDomainOwner | null;
  /** Domain-owned durable intent can remain after this host's runner reloads. */
  onMissingCancellation?: (scope: ActionOperationScope, operationId: string, context: ActionOperationCancellationContext)
    => Promise<ActionOperationCancelV1Response | null>;
  machineId: string;
  resolveAccountId: () => Promise<string | null>;
  /** Current authorized finite-operation inspection can resume its existing admission owner. */
  onInspection?: (operation: ActionOperationSnapshotV1) => void;
}>) {
  const resolveScope = async (context?: ActionOperationRpcContext, sessionId?: string) => {
    const scope = await resolveActionOperationScope(deps, context, sessionId);
    if (!scope) throw new Error('not_authenticated');
    return scope;
  };
  const assertReadActive = (context?: ActionOperationRpcContext) => {
    if (context?.signal?.aborted) throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
  };
  const resolveReadScope = async (context?: ActionOperationRpcContext, sessionId?: string) => {
    const scope = await resolveActionOperationScope(deps, context, sessionId);
    if (!scope) throw new Error('not_authenticated');
    assertReadActive(context);
    return scope;
  };

  const resolveOwnerForOperation = (scope: ActionOperationScope, operationId: string) => {
    const owner = deps.owner?.();
    const retained = deps.store.get(scope, operationId);
    // A known record already names its owner. Do not probe another domain's
    // credentials before observing or stopping retained finite custody.
    return owner && (!retained || owner.actionIds.includes(retained.actionId)) ? owner : null;
  };

  const managedReadScope = (context: ActionOperationRpcContext | undefined, scope: ActionOperationScope,
    actionId: 'action.operations.list' | 'action.operations.get', operationId?: string): string | undefined => {
    const binding = context?.callerInputAuthorization?.binding;
    const admission = binding?.managedAdmission;
    if (!admission || admission.actionId !== 'action.operations.list' && admission.actionId !== 'action.operations.get') return undefined;
    const machine = context?.machineAdmission;
    if (!machine || binding.actionId !== actionId || admission.actionId !== actionId || binding.accountId !== scope.accountId
      || binding.machineId !== scope.machineId || binding.installationId !== machine.installationId
      || binding.custodianAccountId !== machine.custodianAccountId
      || admission.actionId === 'action.operations.get' && admission.input.operationId !== operationId) {
      throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
    }
    return admission.input.managedId;
  };
  const matchesManagedRead = (snapshot: ActionOperationSnapshotV1, managedId: string) =>
    snapshot.domainRef?.kind === 'managedMachine' && snapshot.domainRef.id === managedId;

  const list = async (raw: unknown, context: ActionOperationRpcContext | undefined, version: 1 | 2): Promise<ActionOperationListV1Response> => {
      const request: ActionOperationListV2Request = (version === 2 ? ActionOperationListV2RequestSchema : ActionOperationListV1RequestSchema).parse(raw);
      const requestIdentity = request.requestIdentity;
      const scope = await resolveReadScope(context, request.sessionId);
      const managedId = managedReadScope(context, scope, 'action.operations.list');
      // A retained host request identity does not demand a durable-domain census.
      const owner = requestIdentity || managedId ? null : deps.owner?.();
      if (owner) {
        const snapshots = await owner.list(scope);
        assertReadActive(context);
        if (deps.owner?.() === owner) {
          deps.store.reconcileOwner(scope, owner.actionIds, snapshots);
          for (const snapshot of snapshots) deps.store.project(snapshot);
        }
      }
      const response = deps.store.list({
        ...scope,
        ...(request.states ? { states: request.states } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(requestIdentity ? { requestIdentity } : {}),
      });
      const items = managedId ? response.items.filter(snapshot => matchesManagedRead(snapshot, managedId)) : response.items;
      return ActionOperationListV1ResponseSchema.parse({ ...response,
        items: version === 1 ? items.map(projectActionOperationSnapshotForV1Reader) : items });
  };

  const get = async (raw: unknown, context: ActionOperationRpcContext | undefined, version: 1 | 2): Promise<ActionOperationGetV1Response> => {
      const request = (version === 2 ? ActionOperationGetV2RequestSchema : ActionOperationGetV1RequestSchema).parse(raw);
      const scope = await resolveReadScope(context);
      const managedId = managedReadScope(context, scope, 'action.operations.get', request.operationId);
      const deploymentTokenOrigin = readDeploymentTokenOperationOrigin({ actionId: 'action.operations.get', scope, context });
      const retained = deps.store.get(scope, request.operationId);
      if (deploymentTokenOrigin) {
        if (!retained) return { kind: 'not_found' };
        if (retained.actionId !== 'deployments.deploy'
          || !deps.store.hasMatchingDeploymentTokenOrigin(request.operationId, deploymentTokenOrigin)) {
          throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
        }
      }
      const parentIdentity = await readDeploymentArchiveOperationIdentityForHost(context, ACTION_OPERATION_RPC_METHODS_V2.get);
      // Scoped creator reads never probe another domain owner or wait on a
      // neighbor's operation. Home already rechecked this exact retained row.
      if (managedId && (!retained || !matchesManagedRead(retained, managedId))) return { kind: 'not_found' };
      if (parentIdentity && !retained || retained
        && !deps.store.hasMatchingDeploymentChildIdentity(request.operationId, parentIdentity)) {
        throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
      }
      const owner = resolveOwnerForOperation(scope, request.operationId);
      const projected = owner ? await owner.get(scope, request.operationId) : undefined;
      if (owner) assertReadActive(context);
      if (owner && deps.owner?.() === owner) {
        if (projected) deps.store.project(projected);
        else deps.store.removeOwnerProjections(owner.actionIds, scope, request.operationId);
      }
      await deps.runner.reconcileSessionBirth?.(scope, request.operationId).catch(() => undefined);
      const inspected = deps.store.get(scope, request.operationId);
      if (inspected?.domainRef?.kind === 'projectCommand') deps.onInspection?.(inspected);
      const domainOwner = projected && owner && deps.owner?.() === owner ? owner : null;
      const refreshSetupReview = domainOwner?.refreshSetupReview?.bind(domainOwner) ?? deps.runner.refreshSetupReview?.bind(deps.runner);
      if (version === 2 && inspected?.setupReview && refreshSetupReview) {
        const refresh = refreshSetupReview(scope, request.operationId).then(async () => {
          if (!domainOwner) return;
          const fresh = await domainOwner.get(scope, request.operationId);
          assertReadActive(context);
          if (deps.owner?.() === domainOwner && fresh) deps.store.project(fresh);
        });
        if (('refreshSetupReview' in request && request.refreshSetupReview) || request.includeSetupReview) {
          // Human consent needs freshly measured effect facts before its decision.
          await refresh;
          assertReadActive(context);
        } else {
          // Snapshot reconciliation must not inherit the producer's Home/Sync
          // wait and expire its own read admission. The retained runner owns
          // refresh failure, resume and cancellation; concurrent reads join it.
          void refresh.catch(() => undefined);
        }
      }
      const waitForTerminal = domainOwner?.waitForTerminal?.bind(domainOwner) ?? deps.runner.waitForTerminal?.bind(deps.runner);
      const operation = request.waitForTerminal && waitForTerminal
        ? await waitForTerminal(scope, request.operationId, context?.signal,
          { ...(request.includeSetupReview ? { includeSetupReview: true } : {}),
            ...('includeManagedPrompt' in request && request.includeManagedPrompt ? { includeManagedPrompt: true } : {}) })
        : deps.store.get(scope, request.operationId);
      if (request.waitForTerminal || deploymentTokenOrigin) assertReadActive(context);
      if (deploymentTokenOrigin && operation
        && !deps.store.hasMatchingDeploymentTokenOrigin(request.operationId, deploymentTokenOrigin)) {
        throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
      }
      if (managedId && operation && !matchesManagedRead(operation, managedId)) return { kind: 'not_found' };
      return ActionOperationGetV1ResponseSchema.parse(
        operation ? { kind: 'found', operation: version === 1 ? projectActionOperationSnapshotForV1Reader(operation) : operation } : { kind: 'not_found' },
      );
  };

  return Object.freeze({
    async claimServiceMoveStart(raw: unknown, context?: ActionOperationRpcContext) {
      const request = ProjectServiceMoveStartClaimV1Schema.parse(raw);
      const scope = await resolveScope(context);
      const result = context?.machineAdmission?.installationId === request.installationId
        ? deps.runner.claimServiceMoveStart?.(scope, request.requestId, request.input) : undefined;
      return ProjectServiceMoveStartClaimResultV1Schema.parse(result ?? { kind: 'refused', reasonCode: 'service_move_not_starting' });
    },
    list: (raw: unknown, context?: ActionOperationRpcContext) => list(raw, context, 1),
    listV2: (raw: unknown, context?: ActionOperationRpcContext) => list(raw, context, 2),
    get: (raw: unknown, context?: ActionOperationRpcContext) => get(raw, context, 1),
    getV2: (raw: unknown, context?: ActionOperationRpcContext) => get(raw, context, 2),
    async cancel(raw: unknown, context?: ActionOperationRpcContext): Promise<ActionOperationCancelV1Response> {
      const request = ActionOperationCancelV1RequestSchema.parse(raw);
      const scope = await resolveScope(context);
      const cancellationContext: ActionOperationCancellationContext = {
        signal: context?.signal,
        machineAdmission: context?.machineAdmission,
        verifyMachineAdmissionCurrent: context?.verifyMachineAdmissionCurrent,
        requesterSessionBootstrap: context?.requesterSessionBootstrap,
        callerInputAuthorization: context?.callerInputAuthorization,
        originalActionEnvelope: context?.originalActionEnvelope,
        callerAuthority: context?.callerAuthority,
        callerInputConstraints: context?.callerInputConstraints,
        async assertCurrent() {
          assertReadActive(context);
        },
      };
      const authorization = context?.callerInputAuthorization;
      if (authorization?.binding.actionId === 'action.operations.cancel') {
        const reviewed = await readReviewedActionOperationCancelAddress({ authorization,
          envelope: context?.originalActionEnvelope, signal: context?.signal });
        if (!reviewed || reviewed.machineId !== scope.machineId || reviewed.operationId !== request.operationId) {
          throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
        }
        await cancellationContext.assertCurrent();
      }
      const owner = resolveOwnerForOperation(scope, request.operationId);
      if (owner) {
        const projected = await owner.get(scope, request.operationId);
        await cancellationContext.assertCurrent();
        if (deps.owner?.() === owner) {
          if (projected) deps.store.project(projected);
          else deps.store.removeOwnerProjections(owner.actionIds, scope, request.operationId);
          const result = await owner.cancel(scope, request.operationId, cancellationContext);
          if (result) return ActionOperationCancelV1ResponseSchema.parse(result);
        }
      }
      const result = await deps.runner.requestCancellation(scope, request.operationId, cancellationContext);
      return ActionOperationCancelV1ResponseSchema.parse(result.kind === 'not_found' && !deps.store.get(scope, request.operationId)
        ? await deps.onMissingCancellation?.(scope, request.operationId, cancellationContext) ?? result : result);
    },
  });
}

export type ActionOperationRpcHandlers = ReturnType<typeof createActionOperationRpcHandlers>;

export function registerActionOperationRpcHandlers(
  registrar: RpcHandlerRegistrar,
  handlers: ActionOperationRpcHandlers,
): void {
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.list, handlers.list);
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.get, handlers.get);
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V1.cancel, handlers.cancel);
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V2.list, handlers.listV2);
  registrar.registerHandler(ACTION_OPERATION_RPC_METHODS_V2.get, handlers.getV2);
  registrar.registerHandler(RPC_METHODS.DAEMON_SERVICE_MOVE_START_CLAIM, handlers.claimServiceMoveStart);
}
