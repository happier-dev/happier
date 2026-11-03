import { readMachineDeploymentReferencesV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol';
import { MACHINE_REACHABILITY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { CliActionDepsParams } from './types';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import { verifyManagedCreationAdminAccessInput, verifyManagedCreationAgentIsolationInput } from '@/api/externalActionExecutionAuthorization';
import { executeCapturedMachineAction } from '@/api/machine/capturedMachineAction';
import { MACHINE_VITALS_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineVitals';
import { MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineResources';
import { MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol';
import { MACHINE_STORAGE_ACTION_INPUT_SCHEMAS, MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/storage';
import { MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS, MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineProcesses';
import { listMachineVitalsSummariesV1, readMachineVitalsResourcesProjectionV1 } from '@happier-dev/protocol/machines/vitals/listMachineVitalsSummariesV1';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { CliProjectAdmission, CliProjectAdmissionFailure } from './projectAdmission';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { createMachineServiceControlAction } from './machineServiceControl';
export function createCliMachineResourceActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'isCredentialCurrent' | 'token' | 'externalActionMachineInstallationId' | 'externalActionMachineRequestPrivateKey' | 'serverIdentityId' | 'machineActionDirectTargetTransport' | 'machineGuardAction' | 'savedSecretOperationContext' | 'serverHttpBaseUrl'>,
  { projectHomeAdmission, callMachineAction, assertProjectRequesterCurrent, projectAccountAdmission, withProjectHome, projectHomeId, deploymentStorage, executionRunActionFailure, machineRebootReferences }: Readonly<{
    projectHomeAdmission: CliProjectAdmission['projectHomeAdmission'];
    callMachineAction: CliMachineActionCall;
    assertProjectRequesterCurrent: CliProjectAdmission['assertProjectRequesterCurrent'];
    projectAccountAdmission: CliProjectAdmission['projectAccountAdmission'];
    withProjectHome: CliProjectAdmission['withProjectHome'];
    projectHomeId: string;
    machineRebootReferences?: ActionExecutorDeps['machineRebootReferences'];
    deploymentStorage: NonNullable<ActionExecutorDeps['deploymentAction']>;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => CliProjectAdmissionFailure;
  }>,
): Pick<ActionExecutorDeps, 'machineReachabilityAction' | 'machineStorageAction' | 'machineProcessesAction' | 'machineVitalsAction' | 'machineAgentIsolationAction' | 'machineServiceAction' | 'machineServiceScope' | 'machineServiceControl' | 'machineServiceLogsRead' | 'machineAdminAccessAction' | 'machineReboot' | 'machineResourcesPolicyAction' | 'machineGuardAction' | 'usageSourceAction'> {
  // The incumbent log reader and inventory projection consume one captured Account read.
  // Keep log refusal codes unchanged; inventory receives only the resulting read fact.
  const canReadServiceEnvironment = async (serverId: string, environmentId: string,
    context: ActionExecutorContext): Promise<true | CliProjectAdmissionFailure> => {
    const result = await deploymentStorage('deployments.environments.get', { serverId, environmentId }, context);
    const opened = DeploymentEnvironmentGetResultV1Schema.safeParse(result);
    if (!opened.success) return { ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' };
    if (!opened.data.ok) return executionRunActionFailure(opened.data.error);
    if (opened.data.environment.id !== environmentId || !opened.data.environment.capabilities.read) {
      return { ok: false, errorCode: 'service_unavailable', error: 'service_unavailable' };
    }
    return true;
  };
  return {
    machineReboot: async ({ input, context, signal }) => {
      const denied = await projectAccountAdmission(input.serverId, context);
      if (denied) return denied;
      return withProjectHome(() => executeCapturedMachineAction({ actionId: 'machines.reboot', assertCurrent: async () => {
        signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent())
          throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
        await assertProjectRequesterCurrent(context);
        signal?.throwIfAborted();
      }, invoke: options => {
        const direct = params.machineActionDirectTargetTransport;
        // Only the receiving factory installs this private callback, with its
        // genuine stamped ingress. Other local callers still traverse Home.
        if (direct?.machineId === input.machineId && direct.machineReboot) return direct.machineReboot({ input, context,
          canReadEnvironments: async environmentIds => new Set((await Promise.all(environmentIds.map(async environmentId =>
            await canReadServiceEnvironment(input.serverId, environmentId, context) === true ? environmentId : null)))
            .filter((environmentId): environmentId is string => environmentId !== null)),
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
      serverId: projectHomeId, callMachineAction, admit: projectAccountAdmission,
      assertCurrent: async context => {
        context.signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
        await assertProjectRequesterCurrent(context);
      },
      canControlEnvironment: async (serverId, environmentId, context) => {
        const result = DeploymentEnvironmentGetResultV1Schema.safeParse(await deploymentStorage('deployments.environments.get', { serverId, environmentId }, context));
        if (!result.success) return { ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' };
        if (!result.data.ok) return executionRunActionFailure(result.data.error);
        return result.data.environment.id === environmentId && result.data.environment.capabilities.deploy
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
        if (scopeDenied) throw Object.assign(new Error(scopeDenied.errorCode), { code: scopeDenied.errorCode });
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
          throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
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
    machineProcessesAction: async ({ actionId, input, context, signal }) => {
      const parsed = MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const serverId = parsed.data.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        const scopeDenied = await projectAccountAdmission(serverId, context);
        if (scopeDenied) throw Object.assign(new Error(scopeDenied.errorCode), { code: scopeDenied.errorCode });
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
          throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
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
                const readable = await canReadServiceEnvironment(target.serverId, target.environmentId, context);
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
          throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
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
        const request = MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS[actionId].parse(input);
        if (!await verifyManagedCreationAgentIsolationInput({ actionId, request, context,
          serverHttpBaseUrl: resolveServerHttpBaseUrl(), daemonToken: params.token, serverIdentityId: params.serverIdentityId,
          privateKey: params.externalActionMachineRequestPrivateKey, installationId: params.externalActionMachineInstallationId })) {
          return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        }
        const assertCurrent = async () => {
          signal?.throwIfAborted();
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
          await assertProjectRequesterCurrent(context);
          signal?.throwIfAborted();
        };
        const invoke = (options = {}) => callMachineAction({ machineId: request.machineId, serverId, method: actionId,
          request: { ...request, serverId }, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
          ...(signal ? { signal } : {}), ...options });
        if (actionId === 'machines.agentIsolation.preview') { await assertCurrent(); return invoke(); }
        const { executeCapturedMachineAction } = await import('@/api/machine/capturedMachineAction');
        return executeCapturedMachineAction({ actionId, assertCurrent, invoke });
      });
    },
    machineServiceAction: async ({ actionId, input, context, signal }) => {
      const denied = await projectAccountAdmission(input.serverId, context);
      if (denied) return denied;
      return withProjectHome(() => executeCapturedMachineAction({ actionId, assertCurrent: async () => {
        signal?.throwIfAborted();
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
        await assertProjectRequesterCurrent(context);
        signal?.throwIfAborted();
      }, invoke: async options => {
        const direct = params.machineActionDirectTargetTransport;
        if (direct?.machineId === input.machineId) {
          return direct.machineServiceAction
            ? direct.machineServiceAction({ actionId, input, context, ...(signal ? { signal } : {}),
              requesterAccountId: context.externalActionExecutionAuthorization?.requesterAccountProjection?.accountId
                ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null),
              canReadEnvironment: async environmentId => await canReadServiceEnvironment(input.serverId, environmentId, context) === true })
            : { kind: 'unavailable', reason: 'admission_unavailable' };
        }
        return callMachineAction({ machineId: input.machineId, serverId: input.serverId,
          method: actionId, request: input, authority: context.authority, context, effectActionId: actionId, exactMachine: true,
          ...(signal ? { signal } : {}), ...options });
      } }));
    },
    machineServiceScope: async ({ input, context }) => {
      const direct = params.machineActionDirectTargetTransport;
      if (!direct || direct.machineId !== input.machineId) return null;
      const denied = await projectAccountAdmission(input.serverId, context);
      if (denied) return denied;
      const { withMachineServiceTarget } = await import('@/daemon/local/services/launch/machineServiceTarget');
      const resource = context.machineServiceLogsResource;
      return withMachineServiceTarget({ request: { ...input, ...(resource ? { expectedGeneration: resource.expectedGeneration } : {}) }, machineId: direct.machineId, serverId: projectHomeId,
        ...(context.signal ? { signal: context.signal } : {}), assertCurrent: async () => {
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
          await assertProjectRequesterCurrent(context);
        } }, async handle => {
        if (handle.kind === 'adopted') return handle.actionScope;
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
      const { withMachineServiceTarget } = await import('@/daemon/local/services/launch/machineServiceTarget');
      const resource = context.machineServiceLogsResource;
      return withMachineServiceTarget({ request: { ...input, ...(resource ? { expectedGeneration: resource.expectedGeneration } : {}) }, machineId: direct.machineId, serverId: projectHomeId,
        ...(signal ? { signal } : {}), ...(approvalScope ? { approvalScope } : {}), assertCurrent: async () => {
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
          await assertProjectRequesterCurrent(context);
        } }, async handle => {
        if (!approvalScope) return { ok: false as const, errorCode: 'approval_stale', error: 'approval_stale' };
        if (handle.kind !== 'adopted') {
          const allowed = await canReadServiceEnvironment(input.serverId, handle.environmentId, context);
          if (allowed !== true) return allowed;
        }
        const result = await (handle.readLogs?.({ ...(input.cursor ? { cursor: input.cursor } : {}), ...(signal ? { signal } : {}) })
          ?? { kind: 'unavailable' as const, reason: 'unsupported' as const });
        if (resource?.sourceRevision !== undefined && result.kind === 'page' && result.page.sourceRevision !== resource.sourceRevision)
          return { kind: 'source-changed' as const, sourceRevision: result.page.sourceRevision };
        const observation = resource?.observation;
        if (observation && result.kind === 'page') {
          if (!handle.watchLogs) return { kind: 'unavailable' as const, reason: 'unsupported' as const };
          const retired = () => observation.retire();
          handle.retirementSignal.addEventListener('abort', retired, { once: true });
          let subscription: Awaited<ReturnType<NonNullable<typeof handle.watchLogs>>>;
          try {
            subscription = await handle.watchLogs({ signal: observation.signal,
              ...(input.cursor ? { cursor: input.cursor } : {}), emit: observation.emit });
          } catch (error) { handle.retirementSignal.removeEventListener('abort', retired); throw error; }
          observation.accept({ async dispose() {
            handle.retirementSignal.removeEventListener('abort', retired);
            await subscription.dispose();
          } });
          if (handle.retirementSignal.aborted || !handle.isCurrent()) observation.retire();
        }
        return result;
      });
    },
    machineAdminAccessAction: async ({ actionId, input, context, signal }) => {
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(async () => {
        if (actionId === 'machines.setup.adminAccess.set') {
          if (!await verifyManagedCreationAdminAccessInput({ request: input, context,
            serverHttpBaseUrl: resolveServerHttpBaseUrl(), daemonToken: params.token, serverIdentityId: params.serverIdentityId,
            privateKey: params.externalActionMachineRequestPrivateKey, installationId: params.externalActionMachineInstallationId })) {
            return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
          }
        }
        return executeCapturedMachineAction({ actionId, assertCurrent: async () => {
          signal?.throwIfAborted();
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()) {
            throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
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
        if (actionId === 'machines.resources.policy.set') {
          const request = MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS[actionId].parse(input);
          const { executeCapturedMachineAction } = await import("@/api/machine/capturedMachineAction");
          return executeCapturedMachineAction({ actionId, assertCurrent: async () => {
            signal?.throwIfAborted();
            if (!await current()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
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
    machineGuardAction: async args => {
      const { actionId, input, context, signal } = args;
      const serverId = input.serverId ?? context.serverId ?? projectHomeId;
      const denied = await projectAccountAdmission(serverId, context);
      if (denied) return denied;
      const assertCurrent = async () => {
        signal?.throwIfAborted();
        const denied = await projectAccountAdmission(serverId, context);
        if (denied) throw Object.assign(new Error(denied.errorCode), { code: denied.errorCode });
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
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
      return createUsageSourceActionPort({
        serverId: request.input.serverId,
        assertCurrent: async context => {
          context.signal?.throwIfAborted();
          const denied = await projectHomeAdmission(request.input.serverId, context);
          if (denied) throw Object.assign(new Error('server_target_mismatch'), { code: 'server_target_mismatch' });
          if (params.isCredentialCurrent && !await params.isCredentialCurrent()
            || params.savedSecretOperationContext && !await params.savedSecretOperationContext.isCurrent()) {
            throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
          }
          context.signal?.throwIfAborted();
        },
        rpc: async (request, context) => {
          if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
          const call = () => callMachineAction({ machineId: request.input.machineId, serverId: request.input.serverId,
            method: request.actionId, request: request.input, authority: context.authority, authorization: context.rpcSessionAuthorization,
            context, effectActionId: request.actionId, exactMachine: true, ...(context.signal ? { signal: context.signal } : {}) });
          return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
        },
      })(request, { ...context, serverId: request.input.serverId });
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
        if (scopeDenied) throw Object.assign(new Error(scopeDenied.errorCode), { code: scopeDenied.errorCode });
        await assertProjectRequesterCurrent(context);
        if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
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
    }
};
}
