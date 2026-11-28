import { randomUUID } from 'node:crypto';
import { USAGE_SOURCE_DISMISS_ACTION_ID, USAGE_SOURCE_GET_ACTION_ID } from '@happier-dev/protocol/usage/usageSources';
import type { UsageSourceActionRequest } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import { readMachineDeploymentReferencesV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { CliActionDepsParams } from './types';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import { executeCapturedMachineAction } from '@/api/machine/capturedMachineAction';
import { MACHINE_VITALS_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineVitals';
import { MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineResources';
import { MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineResourcesActionIdsV1';
import { MACHINE_ROLES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineRoles';
import { MACHINE_ISOLATION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineIsolation';
import { MACHINE_ISOLATION_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineIsolationActionIdsV1';
import { MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1, MACHINE_REACHABILITY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machine/agentIsolation';
import { resolveMachineAgentIsolationOperationTimeoutMs } from '@happier-dev/protocol/actions/specs/machine/agentIsolationActionIdsV1';
import { MACHINE_STORAGE_ACTION_INPUT_SCHEMAS, MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/storage';
import { MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS, MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineProcesses';
import { listMachineVitalsSummariesV1, readMachineVitalsResourcesProjectionV1 } from '@happier-dev/protocol/machines/vitals/listMachineVitalsSummariesV1';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { CliProjectAdmission, CliProjectAdmissionFailure } from './projectAdmission';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { createMachineServiceControlAction } from './machineServiceControl';
import { createMachineServiceExecAction } from './machineServiceExec';
import { machineServiceAdmissionFailure } from '@/daemon/local/services/launch/machineServiceFailure';
import { projectVerifiedExternalActionRequesterContext, readRetainedVerifiedExternalActionRequester, selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { isCustodianMachineAdmission } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { MACHINE_SERVICE_LOGS_READ_ACTION_ID } from '@happier-dev/protocol/local/services/actionIdsV1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { CliDeploymentEnvironmentAccessRead, CliDeploymentEnvironmentAccessObserve } from '@/deployments/createCliDeploymentActionDeps';
export function createCliMachineResourceActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'isCredentialCurrent' | 'token' | 'externalActionMachineInstallationId' | 'externalActionMachineRequestPrivateKey' | 'serverIdentityId' | 'machineActionDirectTargetTransport' | 'machineGuardAction' | 'savedSecretOperationContext' | 'serverHttpBaseUrl'>,
  { projectHomeAdmission, callMachineAction, assertProjectRequesterCurrent, projectAccountAdmission, withProjectHome, projectHomeId, readEnvironmentAccess, observeEnvironmentAccessChanges, executionRunActionFailure, machineRebootReferences, resolveServerRequestHeaders, usageSourceDismissalTransport }: Readonly<{
    projectHomeAdmission: CliProjectAdmission['projectHomeAdmission'];
    callMachineAction: CliMachineActionCall;
    assertProjectRequesterCurrent: CliProjectAdmission['assertProjectRequesterCurrent'];
    projectAccountAdmission: CliProjectAdmission['projectAccountAdmission'];
    withProjectHome: CliProjectAdmission['withProjectHome'];
    projectHomeId: string;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, actionId: string,
      request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    usageSourceDismissalTransport?(key: string, request: UsageSourceActionRequest, context: ActionExecutorContext):
      ReturnType<NonNullable<Parameters<typeof createUsageSourceActionPort>[0]['dismissalTransport']>>;
    machineRebootReferences?: ActionExecutorDeps['machineRebootReferences'];
    readEnvironmentAccess: CliDeploymentEnvironmentAccessRead;
    observeEnvironmentAccessChanges: CliDeploymentEnvironmentAccessObserve;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => CliProjectAdmissionFailure;
  }>,
): Pick<ActionExecutorDeps, 'machineScheduledAction' | 'machineStorageAction' | 'machineProcessesAction' | 'machineVitalsAction' | 'machineAgentIsolationAction' | 'machineServiceAction' | 'machineServiceScope' | 'machineServiceControl' | 'machineServiceExec' | 'machineServiceLogsRead' | 'machineAdminAccessAction' | 'machineReboot' | 'machineReachabilityAction' | 'machineResourcesPolicyAction' | 'machineRolesAction' | 'machineIsolationAction' | 'machineGuardAction' | 'usageSourceAction'> {
  // One requester selection for every Service effect and read on this receiver.
  // Raw Machine RPC admission decides when present. A signed original root or
  // private local custody reconciles with this receiver's held Home, its
  // installation and this Machine; credentials never establish custody.
  const selectServiceRequester = (actionContext: ActionExecutorContext, machineId: string) => {
    const context = projectVerifiedExternalActionRequesterContext(actionContext as
      NonNullable<Parameters<typeof selectHostRequesterExecutionIdentity>[0]['actionContext']>);
    const root = context.verifiedExternalActionRequester?.authorization.binding;
    const local = context.authenticatedLocalRootCustody ?? context.localActionContext?.authenticatedLocalRootCustody
      ?? context.inheritedLocalActionContext?.authenticatedLocalRootCustody;
    const custodianAccountId = root?.custodianAccountId ?? local?.accountId;
    const installationId = params.externalActionMachineInstallationId ?? root?.installationId ?? local?.installationId;
    const identity = selectHostRequesterExecutionIdentity({ actionContext: context,
      hostHomeServerIdentityId: params.serverIdentityId ?? projectHomeId,
      ...(custodianAccountId ? { hostCustodianAccountId: custodianAccountId } : {}),
      ...(installationId ? { hostExecutionTarget: { machineId, installationId } } : {}) });
    return { context, root, custodianAccountId, installationId, identity };
  };
  const admitMachineService = async (serverId: string, actionContext: ActionExecutorContext, machineId: string,
    method: string): Promise<CliProjectAdmissionFailure | null> => {
    const denied = await projectAccountAdmission(serverId, actionContext);
    if (denied || params.machineActionDirectTargetTransport?.machineId !== machineId) return denied;
    const required = resolveMachineRpcRoutePolicy(method).sharedMachineAccess;
    if (required === 'use') return null;
    const permits = (custodian: boolean, role?: MachineAccessRoleV1) => custodian
      || required === 'manage' && role === 'manage';
    const refused = (): CliProjectAdmissionFailure => ({ ok: false, errorCode: 'access_denied', error: 'access_denied' });
    const { context, root, custodianAccountId, installationId, identity } = selectServiceRequester(actionContext, machineId);
    // Consume the ingress/Run's retained admission once, before touching a native service.
    // Remote requests retain their Machine RPC admission at the receiving host.
    if (context.machineAdmission && context.machineAdmission.machineId !== machineId) return refused();
    const admission = context.machineAdmission ?? params.savedSecretOperationContext?.machineAdmission;
    if (admission) return permits(isCustodianMachineAdmission(admission), admission.role) ? null : refused();
    if (context.executionRunWorkflowRunId && params.savedSecretOperationContext) return refused();
    if (!custodianAccountId || !installationId) return refused();
    if (identity.kind === 'unknown') return refused();
    return permits(isCustodianMachineAdmission({ actorAccountId: identity.requester.accountId, custodianAccountId }),
      root?.admittedMachineRole) ? null : refused();
  };
  const canReadServiceEnvironments = async (serverId: string, environmentIds: readonly string[],
    context: ActionExecutorContext, actionId: string): Promise<ReadonlySet<string>> => {
    const result = await readEnvironmentAccess({ serverId, environmentIds }, context, actionId);
    if (result.ok) return new Set(result.items.map(item => item.environmentId));
    // Genuine forbidden membership is empty; a failed access read is not an authoritative empty list.
    if ('errorCode' in result) throw result;
    if (result.error === 'deployment_access_denied') return new Set();
    throw executionRunActionFailure(result.error);
  };
  // Inventory/reboot, finite logs and process disclosure share current access facts.
  const canReadServiceEnvironment = async (serverId: string, environmentId: string,
    context: ActionExecutorContext, actionId = 'machines.services.logs.read'): Promise<true | CliProjectAdmissionFailure> => {
    const result = await readEnvironmentAccess({ serverId, environmentIds: [environmentId] }, context, actionId);
    if ('errorCode' in result) return result;
    if (!result.ok) return executionRunActionFailure(result.error);
    return result.items.some(item => item.environmentId === environmentId)
      ? true : { ok: false, errorCode: 'service_unavailable', error: 'service_unavailable' };
  };
  const readServiceRequesterAccountId = (context: ActionExecutorContext) =>
    readRetainedVerifiedExternalActionRequester(context.externalActionExecutionAuthorization)?.authorization.binding.accountId
      ?? context.externalActionExecutionAuthorization?.requesterAccountProjection?.accountId
      ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null);
  return {
    machineServiceExec: createMachineServiceExecAction({
      ...(params.machineActionDirectTargetTransport ? { directMachineId: params.machineActionDirectTargetTransport.machineId } : {}),
      serverId: projectHomeId, callMachineAction, admit: admitMachineService,
      assertCurrent: async context => {
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        await assertProjectRequesterCurrent(context);
      },
      canExecuteEnvironment: async (serverId, environmentId, context) => {
        const result = await readEnvironmentAccess({ serverId, environmentIds: [environmentId] }, context, 'machines.services.exec');
        if ('errorCode' in result) return result;
        if (!result.ok) return executionRunActionFailure(result.error);
        return result.items.some(item => item.environmentId === environmentId && item.deploy)
          ? true : { ok: false, errorCode: 'service_exec_denied', error: 'service_exec_denied' };
      },
    }),
    machineReboot: async ({ input, context, signal }) => {
      const denied = await projectAccountAdmission(input.serverId, context);
      if (denied) return denied;
      return withProjectHome(() => executeCapturedMachineAction({ actionId: 'machines.reboot', assertCurrent: async () => {
        signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent())
          throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        await assertProjectRequesterCurrent(context);
        signal?.throwIfAborted();
      }, invoke: options => {
        const direct = params.machineActionDirectTargetTransport;
        // Only the receiving factory installs this private callback, with its
        // genuine stamped ingress. Other local callers still traverse Home.
        if (direct?.machineId === input.machineId && direct.machineReboot) return direct.machineReboot({ input, context,
          canReadEnvironments: environmentIds => canReadServiceEnvironments(input.serverId, environmentIds, context, 'machines.reboot'),
          ...(machineRebootReferences ? { readDeploymentReferences: () => readMachineDeploymentReferencesV1({
            homeId: projectHomeId, machineId: input.machineId, signal,
          }, page => machineRebootReferences({ input, context, cursor: page.cursor, signal })) } : {}),
          ...(signal ? { signal } : {}) });
        return callMachineAction({ machineId: input.machineId, serverId: input.serverId,
          method: RPC_METHODS.MACHINES_REBOOT, request: input, authority: context.authority,
          context, effectActionId: 'machines.reboot', exactMachine: true, requireCurrentMachine: true,
          ...(context.actionRequestId ? { requestId: context.actionRequestId } : {}),
          ...(signal ? { signal } : {}), ...options });
      } }));
    },
    machineServiceControl: createMachineServiceControlAction({
      ...(params.machineActionDirectTargetTransport ? { directMachineId: params.machineActionDirectTargetTransport.machineId } : {}),
      serverId: projectHomeId, callMachineAction, admit: admitMachineService,
      assertCurrent: async context => {
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        await assertProjectRequesterCurrent(context);
      },
      canControlEnvironment: async (serverId, environmentId, context) => {
        const result = await readEnvironmentAccess({ serverId, environmentIds: [environmentId] }, context, 'machines.services.control');
        if ('errorCode' in result) return result;
        if (!result.ok) return executionRunActionFailure(result.error);
        return result.items.some(item => item.environmentId === environmentId && item.deploy)
          ? true : { ok: false, errorCode: 'service_control_denied', error: 'service_control_denied' };
      },
    }),
    machineStorageAction: async ({ actionId, input, context, signal }) => {
      const parsed = MACHINE_STORAGE_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const serverId = parsed.data.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        const scopeDenied = await projectAccountAdmission(serverId, context);
        if (scopeDenied) throw createActionExecuteFailureError(scopeDenied);
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
          throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        }
        signal?.throwIfAborted();
      };
      return withProjectHome(async () => {
        const spec = getActionSpec(actionId);
        const { executeCapturedMachineAction } = await import("@/api/machine/capturedMachineAction");
        const raw = await executeCapturedMachineAction({ actionId, assertCurrent,
          invoke: options => callMachineAction({ machineId: parsed.data.machineId, serverId,
            method: spec.bindings!.rpcMethod!, request: { ...parsed.data, serverId },
            authority: context.authority, context, effectActionId: actionId, exactMachine: true, timeoutMs: null,
            ...(signal ? { signal } : {}), ...options }) });
        const failure = ActionExecuteFailureSchema.safeParse(raw);
        if (failure.success) return failure.data;
        const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
        if (deferred.success && deferred.data.actionId === actionId) return deferred.data;
        const output = MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(raw);
        return output.success ? output.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
      });
    },
    machineScheduledAction: async ({ actionId, input, context, signal }) => {
      const denied = await projectAccountAdmission(input.serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
      };
      return withProjectHome(() => executeCapturedMachineAction({ actionId, assertCurrent,
        invoke: options => callMachineAction({ machineId: input.machineId, serverId: input.serverId,
          method: getActionSpec(actionId).bindings!.rpcMethod!, request: input, authority: context.authority,
          context, effectActionId: actionId, exactMachine: true, timeoutMs: null, ...(signal ? { signal } : {}), ...options }) }));
    },
    machineProcessesAction: async ({ actionId, input, context, signal }) => {
      const parsed = MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const serverId = parsed.data.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        const scopeDenied = await projectAccountAdmission(serverId, context);
        if (scopeDenied) throw createActionExecuteFailureError(scopeDenied);
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
          throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        }
        signal?.throwIfAborted();
      };
      return withProjectHome(async () => {
        const { executeCapturedMachineAction } = await import("@/api/machine/capturedMachineAction");
        const raw = await executeCapturedMachineAction({ actionId, assertCurrent,
          invoke: options => callMachineAction({ machineId: parsed.data.machineId, serverId,
            ...(['machines.processes.list', 'machines.processes.get', 'machines.processes.check'].includes(actionId) ? {
              processEnvironmentRead: async (target: Readonly<{ serverId: string; environmentId: string }>) => {
                await assertCurrent();
                const readable = await canReadServiceEnvironment(target.serverId, target.environmentId, context, actionId);
                await assertCurrent();
                return readable === true;
              },
            } : {}),
            method: getActionSpec(actionId).bindings!.rpcMethod!, request: { ...parsed.data, serverId },
            authority: context.authority, context, effectActionId: actionId, exactMachine: true, timeoutMs: null,
            ...(signal ? { signal } : {}), ...options }) });
        const failure = ActionExecuteFailureSchema.safeParse(raw);
        if (failure.success) return failure.data;
        const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
        if (deferred.success && deferred.data.actionId === actionId) return deferred.data;
        const output = MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(raw);
        return output.success ? output.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
      });
    },
    machineVitalsAction: async ({ actionId, input, context, signal }) => {
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
          throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        }
      };
      const read = async (machineId: string, method: string, request: unknown) => {
        const { executeCapturedMachineAction } = await import('@/api/machine/capturedMachineAction');
        return executeCapturedMachineAction({ actionId, assertCurrent,
          invoke: options => callMachineAction({ machineId, serverId, method, request, authority: context.authority,
            context, effectActionId: actionId, exactMachine: true, ...(signal ? { signal } : {}), ...options }) });
      };
      const execute = async () => {
        if (actionId !== 'machines.vitals.summaries.list') {
          const target = actionId === 'machines.vitals.get'
            ? MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.get'].parse(input)
            : MACHINE_VITALS_ACTION_INPUT_SCHEMAS['machines.vitals.history.get'].parse(input);
          return await read(target.machineId, getActionSpec(actionId).bindings!.rpcMethod!, { ...target, serverId });
        }
        const { listCurrentAccountMachines } = await import('@/api/machine/resolveCurrentAccountMachineTarget');
        const { ApiClient } = await import('@/api/api');
        const authorization = context.externalActionExecutionAuthorization;
        await assertCurrent();
        const inventory = await listCurrentAccountMachines({ token: params.token, ...(authorization ? { authorization } : {}),
          effectActionId: actionId, ...(signal ? { signal } : {}) });
        const api = params.credentials ? await ApiClient.create(params.credentials) : null;
        const machines = await Promise.all(inventory.filter(row => row.revokedAt === null && row.replacedByMachineId === null).map(async row => {
          try {
            const opened = authorization
              ? await ApiClient.getRequesterMachine(row.id, { authorization, effectActionId: actionId, ...(signal ? { signal } : {}) })
              : await api!.getMachine(row.id, { ...(signal ? { signal } : {}) });
            await assertCurrent();
            return { machineId: row.id, name: opened?.metadata?.displayName ?? opened?.metadata?.host ?? row.label,
              online: row.active, resources: readMachineVitalsResourcesProjectionV1(opened?.daemonState), unavailable: !opened };
          } catch {
            await assertCurrent();
            return { machineId: row.id, name: row.label, online: row.active, unavailable: true };
          }
        }));
        const result = await listMachineVitalsSummariesV1({ machines, readSummary: machineId => read(machineId,
          RPC_METHODS.MACHINES_VITALS_GET, { serverId, machineId, view: 'summary' }), ...(signal ? { signal } : {}) });
        await assertCurrent();
        return result;
      };
      return await withProjectHome(execute);
    },
    machineAgentIsolationAction: async ({ actionId, input, context, signal }) => {
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(async () => {
        const policyRequest = actionId === 'machines.agentIsolation.status' ? null
          : MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS[actionId].parse(input);
        const request = policyRequest ?? MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS['machines.agentIsolation.status'].parse(input);
        const assertCurrent = async () => {
          signal?.throwIfAborted();
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
          await assertProjectRequesterCurrent(context);
          signal?.throwIfAborted();
        };
        const invoke = (options = {}) => callMachineAction({ machineId: request.machineId, serverId, method: actionId,
          request: { ...request, serverId }, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
          timeoutMs: resolveMachineAgentIsolationOperationTimeoutMs(actionId),
          ...(signal ? { signal } : {}), ...options });
        if (actionId === 'machines.agentIsolation.preview' || actionId === 'machines.agentIsolation.status') { await assertCurrent(); return invoke(); }
        const { executeCapturedMachineAction } = await import('@/api/machine/capturedMachineAction');
        return executeCapturedMachineAction({ actionId, assertCurrent, invoke });
      });
    },
    machineServiceAction: async ({ actionId, input, context, signal }) => {
      const denied = await admitMachineService(input.serverId, context, input.machineId,
        getActionSpec(actionId).bindings!.rpcMethod!);
      if (denied) return denied;
      return withProjectHome(() => executeCapturedMachineAction({ actionId, assertCurrent: async () => {
        signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        await assertProjectRequesterCurrent(context);
        signal?.throwIfAborted();
      }, invoke: async options => {
        const direct = params.machineActionDirectTargetTransport;
        if (direct?.machineId === input.machineId) {
          return direct.machineServiceAction
            ? direct.machineServiceAction({ actionId, input, context, ...(signal ? { signal } : {}),
              requesterAccountId: readServiceRequesterAccountId(context),
              canReadEnvironments: environmentIds => canReadServiceEnvironments(input.serverId, environmentIds, context, actionId),
              observeEnvironmentAccessChanges: listener => observeEnvironmentAccessChanges({ serverId: input.serverId }, context, listener) })
            : machineServiceAdmissionFailure('service.runtime.port');
        }
        return callMachineAction({ machineId: input.machineId, serverId: input.serverId,
          method: actionId, request: input, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
          ...(signal ? { signal } : {}), ...options });
      } }));
    },
    machineServiceScope: async ({ actionId, input, context }) => {
      const direct = params.machineActionDirectTargetTransport;
      if (!direct || direct.machineId !== input.machineId) return null;
      const denied = await projectAccountAdmission(input.serverId, context);
      if (denied) return denied;
      const { withMachineServiceTarget, withMachineServiceLogTarget } = await import('@/daemon/local/services/launch/machineServiceTarget');
      const select = actionId === MACHINE_SERVICE_LOGS_READ_ACTION_ID ? withMachineServiceLogTarget : withMachineServiceTarget;
      const resource = context.machineServiceLogsResource;
      const scopeRequester = selectServiceRequester(context, direct.machineId).identity;
      return select({ request: { ...input, ...(resource ? { expectedGeneration: resource.expectedGeneration } : {}) }, machineId: direct.machineId, serverId: projectHomeId,
        requesterAccountId: readServiceRequesterAccountId(context), context,
        ...(scopeRequester.kind !== 'unknown' ? { requester: scopeRequester.requester } : {}),
        ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => {
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
          await assertProjectRequesterCurrent(context);
        } }, async handle => {
        if (handle.kind !== 'environment') return handle.actionScope;
        const allowed = await canReadServiceEnvironment(input.serverId, handle.environmentId, context);
        return allowed === true ? handle.actionScope : allowed;
      });
    },
    machineServiceLogsRead: async ({ input, context, signal, approvalScope }) => {
      const denied = await projectAccountAdmission(input.serverId, context);
      if (denied) return denied;
      const direct = params.machineActionDirectTargetTransport;
      if (!direct || direct.machineId !== input.machineId) return callMachineAction({ machineId: input.machineId,
        serverId: input.serverId, method: RPC_METHODS.MACHINES_SERVICE_LOGS_READ, request: input,
        authority: context.authority, context, effectActionId: 'machines.services.logs.read', exactMachine: true,
        ...(signal ? { signal } : {}) });
      const [{ withMachineServiceLogTarget }, { canReadIncompleteSecretMaskingForHost }] = await Promise.all([
        import('@/daemon/local/services/launch/machineServiceTarget'),
        import('@/plugins/runtime/invocation/services/managedServiceNativeLogs'),
      ]);
      const resource = context.machineServiceLogsResource;
      const logRequester = selectServiceRequester(context, direct.machineId).identity;
      return withMachineServiceLogTarget({ request: { ...input, ...(resource ? { expectedGeneration: resource.expectedGeneration } : {}) }, machineId: direct.machineId, serverId: projectHomeId,
        requesterAccountId: readServiceRequesterAccountId(context), context,
        ...(logRequester.kind !== 'unknown' ? { requester: logRequester.requester } : {}),
        ...(signal ? { signal } : {}), ...(approvalScope ? { approvalScope } : {}), assertCurrent: async () => {
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
          await assertProjectRequesterCurrent(context);
        } }, async handle => {
        if (!approvalScope) return { ok: false as const, errorCode: 'approval_stale', error: 'approval_stale' };
        const observation = resource?.observation;
        let access: { dispose(): Promise<void> } | undefined;
        try {
          if (handle.kind === 'environment') {
            const { environmentId } = handle;
            if (observation && handle.watchLogs) {
              // Subscribe before the initial access read. That read covers the initial reset.
              let establishing = true;
              const watched = await observeEnvironmentAccessChanges({ serverId: input.serverId },
                { ...context, signal: observation.signal }, event => {
                  if (event.kind === 'retired' || !establishing
                    && (event.kind === 'reset' || event.environmentIds.includes(environmentId))) observation.retire();
                });
              establishing = false;
              if ('errorCode' in watched) return watched;
              access = watched;
            }
            const allowed = await canReadServiceEnvironment(input.serverId, environmentId, context);
            if (allowed !== true) return allowed;
          }
          observation?.signal.throwIfAborted();
          const allowIncompleteSecretMasking = canReadIncompleteSecretMaskingForHost(context)
            && logRequester.kind === 'owner_person';
          const result = await (handle.readLogs?.({ ...(input.cursor ? { cursor: input.cursor } : {}), ...(signal ? { signal } : {}),
            ...(allowIncompleteSecretMasking ? { allowIncompleteSecretMasking: true as const } : {}) })
            ?? { kind: 'unavailable' as const, reason: 'unsupported' as const });
          if (resource?.sourceRevision !== undefined && result.kind === 'page' && result.page.sourceRevision !== resource.sourceRevision)
            return { kind: 'source-changed' as const, sourceRevision: result.page.sourceRevision };
          if (observation && result.kind === 'page') {
            if (!handle.watchLogs) return { kind: 'unavailable' as const, reason: 'unsupported' as const };
            const retired = () => observation.retire();
            handle.retirementSignal.addEventListener('abort', retired, { once: true });
            const cursor = result.page.nextCursor ?? input.cursor;
            let subscription: Awaited<ReturnType<NonNullable<typeof handle.watchLogs>>>;
            try {
              subscription = await handle.watchLogs({ signal: observation.signal,
                ...(cursor ? { cursor } : {}), emit(value) {
                  if (value.kind === 'unavailable') observation.retire(new PluginError({ code: value.reason }));
                  else if (value.kind === 'source-changed') observation.retire(new PluginError({ code: value.kind }));
                  else if (!observation.signal.aborted) observation.emit(value);
                } });
            } catch (error) { handle.retirementSignal.removeEventListener('abort', retired); throw error; }
            const retainedAccess = access;
            observation.accept({ async dispose() {
              handle.retirementSignal.removeEventListener('abort', retired);
              try { await subscription.dispose(); } finally { await retainedAccess?.dispose(); }
            } });
            access = undefined;
            if (handle.retirementSignal.aborted || !handle.isCurrent()) observation.retire();
          }
          return result;
        } finally {
          await access?.dispose();
        }
      });
    },
    machineReachabilityAction: async ({ actionId, input, context, signal }) => {
      const parsed = MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const serverId = parsed.data.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        const scopeDenied = await projectAccountAdmission(serverId, context);
        if (scopeDenied) throw createActionExecuteFailureError(scopeDenied);
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        signal?.throwIfAborted();
      };
      return withProjectHome(async () => {
        const raw = await executeCapturedMachineAction({ actionId, assertCurrent,
          invoke: options => callMachineAction({ machineId: parsed.data.machineId, serverId,
            method: getActionSpec(actionId).bindings!.rpcMethod!, request: { ...parsed.data, serverId },
            authority: context.authority, context, effectActionId: actionId, exactMachine: true,
            ...(signal ? { signal } : {}), ...options }) });
        const failure = ActionExecuteFailureSchema.safeParse(raw);
        if (failure.success) return failure.data;
        const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
        if (deferred.success && deferred.data.actionId === actionId) return deferred.data;
        const output = MACHINE_REACHABILITY_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(raw);
        return output.success ? output.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
      });
    },
    machineAdminAccessAction: async ({ actionId, input, context, signal }) => {
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(async () => {
        return executeCapturedMachineAction({ actionId, assertCurrent: async () => {
          signal?.throwIfAborted();
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
          }
          await assertProjectRequesterCurrent(context);
          signal?.throwIfAborted();
        }, invoke: options => callMachineAction({ machineId: input.machineId, serverId,
          method: getActionSpec(actionId).bindings!.rpcMethod!, request: { ...input, serverId },
          authority: context.authority, context, effectActionId: actionId, exactMachine: true,
          ...(signal ? { signal } : {}), ...options }) });
      });
    },
    machineResourcesPolicyAction: async ({ actionId, input, context, signal }) => {
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const current = async () => {
        if (signal?.aborted || params.isCredentialCurrent && !await params.isCredentialCurrent()) return false;
        await assertProjectRequesterCurrent(context);
        return true;
      };
      const execute = async () => {
        if (!await current()) return { status: 'unavailable' };
        if (actionId === MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1) {
          if (!params.credentials) return { status: 'unavailable' };
          const request = MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS[actionId].parse(input);
          const { createCliAccountKvJsonCollectionTransport } = await import('@/api/client/accountKvJsonTransport');
          const { readMachineOutcomeSummaries } = await import('@happier-dev/protocol/machines/resources/machineOutcomeSummaryV1');
          const transport = createCliAccountKvJsonCollectionTransport({ credentials: params.credentials,
            serverBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), ...(signal ? { signal } : {}),
            shouldContinue: () => !signal?.aborted,
            resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request) });
          const outcomes = await readMachineOutcomeSummaries(transport, request.keys);
          if (!await current()) return { status: 'unavailable' };
          return { status: 'ready', outcomes: outcomes.filter(outcome => outcome.serverId === serverId) };
        }
        if (actionId === 'machines.resources.policy.set') {
          const request = MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS[actionId].parse(input);
          const { executeCapturedMachineAction } = await import("@/api/machine/capturedMachineAction");
          return executeCapturedMachineAction({ actionId, assertCurrent: async () => {
            signal?.throwIfAborted();
            if (!await current()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
            signal?.throwIfAborted();
          }, invoke: options => callMachineAction({ machineId: request.machineId, serverId, method: RPC_METHODS.MACHINES_RESOURCES_POLICY_SET,
            request: { ...request, serverId }, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
            ...(signal ? { signal } : {}), ...options }) });
        }
        const request = MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS[actionId].parse(input);
        const { readMachineResourcesPolicySnapshot } = await import('@/api/machine/machineResourcesPolicy');
        const { ApiClient } = await import('@/api/api');
        const authorization = context.externalActionExecutionAuthorization;
        return readMachineResourcesPolicySnapshot({ machineId: request.machineId, isCurrent: current, readMachine: async () => {
          if (authorization) return ApiClient.getRequesterMachine(request.machineId, { authorization, effectActionId: actionId, ...(signal ? { signal } : {}) });
          if (!params.credentials) return null;
          const api = await ApiClient.create(params.credentials);
          return api.getMachine(request.machineId, { ...(signal ? { signal } : {}) });
        } });
      };
      return withProjectHome(execute);
    },
    machineRolesAction: async ({ actionId, input, context, signal }) => {
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const current = async () => {
        if (signal?.aborted || params.isCredentialCurrent && !await params.isCredentialCurrent()) return false;
        await assertProjectRequesterCurrent(context);
        return true;
      };
      return withProjectHome(async () => {
        if (!await current()) return { status: 'unavailable' };
        if (actionId === 'machines.roles.set') {
          const request = MACHINE_ROLES_ACTION_INPUT_SCHEMAS[actionId].parse(input);
          // Ingress admitted the exact signed creation-child input; the target owns field comparison.
          return executeCapturedMachineAction({ actionId, assertCurrent: async () => {
            signal?.throwIfAborted();
            if (!await current()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
            signal?.throwIfAborted();
          }, invoke: options => callMachineAction({ machineId: request.machineId, serverId, method: RPC_METHODS.MACHINES_ROLES_SET,
            request: { ...request, serverId }, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
            ...(signal ? { signal } : {}), ...options }) });
        }
        // List and Get read the synced Machine metadata, so they work while the Machine is offline.
        const request = MACHINE_ROLES_ACTION_INPUT_SCHEMAS[actionId].parse(input);
        const { readMachineRolesSnapshot } = await import('@/api/machine/machineRoles');
        const { ApiClient } = await import('@/api/api');
        const authorization = context.externalActionExecutionAuthorization;
        return readMachineRolesSnapshot({ actionId, machineId: request.machineId, isCurrent: current, readMachine: async () => {
          if (authorization) return ApiClient.getRequesterMachine(request.machineId, { authorization, effectActionId: actionId, ...(signal ? { signal } : {}) });
          if (!params.credentials) return null;
          const api = await ApiClient.create(params.credentials);
          return api.getMachine(request.machineId, { ...(signal ? { signal } : {}) });
        } });
      });
    },
    machineIsolationAction: async ({ actionId, input, context, signal }) => {
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const current = async () => {
        if (signal?.aborted || params.isCredentialCurrent && !await params.isCredentialCurrent()) return false;
        await assertProjectRequesterCurrent(context);
        return true;
      };
      return withProjectHome(async () => {
        if (!await current()) return { status: 'unavailable' };
        if (actionId === MACHINE_ISOLATION_SET_ACTION_ID_V1) {
          const request = MACHINE_ISOLATION_ACTION_INPUT_SCHEMAS[actionId].parse(input);
          return executeCapturedMachineAction({ actionId, assertCurrent: async () => {
            signal?.throwIfAborted();
            if (!await current()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
            signal?.throwIfAborted();
          }, invoke: options => callMachineAction({ machineId: request.machineId, serverId, method: RPC_METHODS.MACHINES_ISOLATION_SET,
            request: { ...request, serverId }, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
            ...(signal ? { signal } : {}), ...options }) });
        }
        // Get reads the synced Machine metadata, so they work while the Machine is offline.
        const request = MACHINE_ISOLATION_ACTION_INPUT_SCHEMAS[actionId].parse(input);
        const { readMachineIsolationSnapshot } = await import('@/api/machine/machineIsolation');
        const { ApiClient } = await import('@/api/api');
        const authorization = context.externalActionExecutionAuthorization;
        return readMachineIsolationSnapshot({ machineId: request.machineId, isCurrent: current, readMachine: async () => {
          if (authorization) return ApiClient.getRequesterMachine(request.machineId, { authorization, effectActionId: actionId, ...(signal ? { signal } : {}) });
          if (!params.credentials) return null;
          const api = await ApiClient.create(params.credentials);
          return api.getMachine(request.machineId, { ...(signal ? { signal } : {}) });
        } });
      });
    },
    machineGuardAction: async args => {
      const { actionId, input, context, signal } = args;
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        const denied = await projectAccountAdmission(serverId, context);
        if (denied) throw createActionExecuteFailureError(denied);
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        signal?.throwIfAborted();
      };
      const targetLocalAction = params.machineGuardAction;
      if (actionId === 'machines.guard.activity.undo' && targetLocalAction) {
        const { executeCapturedMachineAction } = await import("@/api/machine/capturedMachineAction");
        return withProjectHome(() =>
        executeCapturedMachineAction({ actionId, assertCurrent, invoke: () => targetLocalAction(args) }));
      }
      const { executeMachineGuardAction } = await import('@/api/machine/machineGuard');
      return withProjectHome(() => executeMachineGuardAction({ actionId, input, serverId,
        assertCurrent,
        call: request => callMachineAction({ machineId: request.machineId, serverId, method: request.method,
          request: request.input, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(signal ? { signal } : {}) }),
      }));
    },
  
    usageSourceAction: async (request, context) => {
      const denied = await projectHomeAdmission(request.input.serverId, context);
      if (denied) return executionRunActionFailure('server_target_mismatch');
      const { credentials } = params;
      return createUsageSourceActionPort({
        serverId: request.input.serverId,
        assertCurrent: async context => {
          context.signal?.throwIfAborted();
          const denied = await projectHomeAdmission(request.input.serverId, context);
          if (denied) throw Object.assign(new Error('server_target_mismatch'), { code: 'server_target_mismatch' });
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()
            || params.savedSecretOperationContext && !await params.savedSecretOperationContext.isCurrent()) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
          }
          context.signal?.throwIfAborted();
        },
        ...(usageSourceDismissalTransport ? {
          dismissalTransport: (key, context) => usageSourceDismissalTransport(key, request, context),
        } : {}),
        rpc: async (request, context) => {
          const binding = context.externalActionExecutionAuthorization?.binding;
          if (request.actionId === USAGE_SOURCE_GET_ACTION_ID && binding?.actionId === USAGE_SOURCE_DISMISS_ACTION_ID
            && binding.sessionActionOrigin) {
            const executeRead = context.executeOrdinaryChildAction;
            if (!executeRead) return executionRunActionFailure('requester_account_context_unavailable');
            const result = await executeRead(request.actionId, request.input, {
              externalActionTarget: { kind: 'machine', machineId: request.input.machineId },
              actionRequestId: randomUUID(), ...(context.signal ? { signal: context.signal } : {}),
            });
            return result.ok ? result.result : result;
          }
          if (!credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
          const call = () => callMachineAction({ machineId: request.input.machineId, serverId: request.input.serverId,
            method: request.actionId, request: request.input, authority: context.authority, authorization: context.rpcSessionAuthorization,
            context, effectActionId: request.actionId, exactMachine: true, ...(context.signal ? { signal: context.signal } : {}) });
          return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
        },
      })(request, { ...context, serverId: request.input.serverId });
    },
  };
}
