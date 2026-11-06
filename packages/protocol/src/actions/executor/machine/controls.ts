import { MachineAgentIsolationPreviewResultV1Schema, type MachineAgentIsolationSetInputV1 } from '../../../machines/agentIsolationV1.js';
import type { z } from 'zod/mini';
import { MachineServiceExecInputV1Schema } from '../../specs/machine/services.js';
import { MachineServiceExecResultV1Schema } from '../../specs/machine/services.js';
import type { AdmittedActionInputById } from '../../actionSpecs.js';
import { MachineReachabilityActionIdV1Schema } from '../../specs/machineReachability.js';
import { MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1 } from '../../../machines/reachability/actionsV1.js';
import { MachineWorkSummaryGetInputV1Schema } from '../../../machines/machineWorkSummaryV1.js';
import { MachineRebootInputV1Schema, MachineRebootResultV1Schema } from '../../specs/machine/reboot.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { isActionFamilyId } from '../actionFamilies.js';
import { MachineServiceLogsReadInputV1Schema, MachineServiceControlInputV1Schema, MachineServiceControlResultV1Schema, MachineServiceActionIdSchema, MACHINE_SERVICE_ACTION_INPUT_SCHEMAS, MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS } from '../../specs/machine/services.js';
import { MachineVitalsActionIdSchema, MACHINE_VITALS_ACTION_INPUT_SCHEMAS } from '../../specs/machineVitals.js';
import { ManagedServiceNativeLogResultV1Schema } from '../../../local/services/nativeLogsV1.js';
import { MachineStorageActionIdSchema, MACHINE_STORAGE_ACTION_INPUT_SCHEMAS } from '../../specs/storage.js';
import { MachineProcessesActionIdSchema, MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS } from '../../specs/machineProcesses.js';
import { MachineResourcesActionIdSchema, MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS } from '../../specs/machineResources.js';
import { MachineAdminAccessActionIdSchema, MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS } from '../../specs/machine/adminAccess.js';
import { MachineAgentIsolationActionIdSchema, MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS } from '../../specs/machine/agentIsolation.js';
import { MachineGuardActionIdSchema, MACHINE_GUARD_ACTION_INPUT_SCHEMAS } from '../../specs/machineGuard.js';
import { type ActionId } from '../../actionIds.js';
import { readRecord } from '../../../inputs/inputRecords.js';
import { MachineAccessActionIdSchema } from '../../specs/machine/access.js';
import { MachinePoolResolveInputV1Schema, MachinePoolViewV1Schema } from '../../../machines/pools/v1.js';
import { resolveMachinePoolWorkerCandidateV1 } from '../../../machines/pools/machinePoolWorkerPlacement.js';
import { MachinePoolActionIdV1Schema, MachinePoolActionInputSchemasV1 } from '../../../machines/pools/actionsV1.js';
import { LOCAL_DAEMON_SERVICE_ACTION_IDS, LOCAL_DAEMON_SERVICE_INPUT_SCHEMAS, type LocalDaemonServiceActionId } from '../../specs/localDaemonService.js';
import { completeActionResult } from '../resultProjection.js';
import { HomeConnectInputSchema, HomeReconnectInputSchema, MachineAddCommandInputSchema, MachinePairingCreateInputSchema, MACHINE_ADD_SSH_ACTION_IDS, MACHINE_ADD_SSH_INPUT_SCHEMAS, MACHINE_PAGE_ACTION_IDS, MACHINE_PAGE_ACTION_INPUT_SCHEMAS, type MachineAddSshActionId, type MachinePageActionId } from '../../specs/machineConnection.js';
import { MachineManagedInstallationRespondInputSchema } from '../../specs/machineConnection.js';
import { MachineAddLocalStartInputSchema } from '../../specs/machineConnection.js';
import { isMachineTerminalActionId, MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS } from '../../specs/machineTerminal.js';
import type { ActionExecuteResult, ActionExecutorContext } from '../types.js';
import type { ActionApprovalScopeV1 } from '../../actionSettings.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecutorDeps } from '../types.js';



/** Read the target once at admission, before either Ask or waived execution. */
export async function readMachineAgentIsolationSetAdmission(
  deps: ActionExecutorDeps,
  input: MachineAgentIsolationSetInputV1,
  context: ActionExecutorContext,
): Promise<ActionExecuteResult | null> {
  if (!deps.machineAgentIsolationAction) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:machines.agentIsolation.set' };
  const { expectedMetadataVersion, expectedPolicy: _policy, expectedPlanDigest: _digest, ...previewInput } = input;
  const result = await deps.machineAgentIsolationAction({ actionId: 'machines.agentIsolation.preview', input: previewInput,
    context, ...(context.signal ? { signal: context.signal } : {}) });
  const failure = readActionFailureEnvelope(result);
  if (failure) return failure;
  const parsed = MachineAgentIsolationPreviewResultV1Schema.safeParse(result);
  if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  if (parsed.data.kind === 'unavailable') return { ok: true, result: { kind: 'failed', code: 'unavailable' } };
  if (parsed.data.metadataVersion !== expectedMetadataVersion) return { ok: true,
    result: { kind: 'conflict', policy: parsed.data.policy, metadataVersion: parsed.data.metadataVersion } };
  return null;
}


export async function dispatchMachineControls1(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'parsed' | 'ctx'> & Readonly<{
  isSameHome: (targetServerId: unknown, currentServerId: string | null | undefined, ctx: ActionExecutorContext) => boolean;
  approvalScope: ActionApprovalScopeV1 | undefined;
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, parsed, ctx, isSameHome, approvalScope, executeHostChild } = inv;
      if (actionId === 'machines.services.exec') {
        const input = parsed.data as z.infer<typeof MachineServiceExecInputV1Schema>;
        if (ctx.serverId && !isSameHome(input.serverId, ctx.serverId, ctx))
          return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineServiceExec) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        const result = await deps.machineServiceExec({ input, context: ctx,
          ...(approvalScope ? { approvalScope } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: MachineServiceExecResultV1Schema.parse(result) };
      }
      if (actionId === 'machines.reboot') {
        const input = parsed.data as AdmittedActionInputById['machines.reboot'];
        if (ctx.serverId && !isSameHome(input.serverId, ctx.serverId, ctx))
          return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineReboot) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        const result = await deps.machineReboot({ input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: MachineRebootResultV1Schema.parse(result) };
      }
      if (actionId === 'machines.work.summary.get') {
        if (!deps.machineWorkSummaryGet) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const target = parsed.data as AdmittedActionInputById['machines.work.summary.get'];
        if (ctx.serverId && !isSameHome(target.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        const result = await deps.machineWorkSummaryGet({ input: target, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const machineServiceActionId = isActionFamilyId(actionId, MachineServiceActionIdSchema) ? actionId : null;
      if (machineServiceActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_SERVICE_ACTION_INPUT_SCHEMAS)[typeof machineServiceActionId]>;
        if (ctx.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineServiceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineServiceAction({ actionId: machineServiceActionId, input, context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: MACHINE_SERVICE_ACTION_OUTPUT_SCHEMAS[machineServiceActionId].parse(result) };
      }
      const machineVitalsActionId = isActionFamilyId(actionId, MachineVitalsActionIdSchema) ? actionId : null;
      if (actionId === 'machines.services.control') {
        if (!deps.machineServiceControl) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineServiceControl({ input: parsed.data as z.infer<typeof MachineServiceControlInputV1Schema>,
          context: ctx, ...(approvalScope ? { approvalScope } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: MachineServiceControlResultV1Schema.parse(result) };
      }
      if (actionId === 'machines.services.logs.read') {
        if (!deps.machineServiceLogsRead) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineServiceLogsRead({ input: parsed.data as z.infer<typeof MachineServiceLogsReadInputV1Schema>,
          context: ctx, ...(approvalScope ? { approvalScope } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result: ManagedServiceNativeLogResultV1Schema.parse(result) };
      }
      const machineStorageActionId = isActionFamilyId(actionId, MachineStorageActionIdSchema) ? actionId : null;
      const machineProcessesActionId = isActionFamilyId(actionId, MachineProcessesActionIdSchema) ? actionId : null;
      if (machineProcessesActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS)[typeof machineProcessesActionId]>;
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineProcessesAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineProcessesAction({ actionId: machineProcessesActionId, input, context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (machineStorageActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_STORAGE_ACTION_INPUT_SCHEMAS)[typeof machineStorageActionId]>;
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineStorageAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineStorageAction({ actionId: machineStorageActionId, input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const machineResourcesActionId = isActionFamilyId(actionId, MachineResourcesActionIdSchema) ? actionId : null;
      const machineReachabilityActionId = isActionFamilyId(actionId, MachineReachabilityActionIdV1Schema) ? actionId : null;
      if (machineReachabilityActionId !== null) {
        const input = MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1[machineReachabilityActionId].parse(parsed.data);
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineReachabilityAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineReachabilityAction({ actionId: machineReachabilityActionId, input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return completeActionResult(result);
      }
      const machineAdminAccessActionId = isActionFamilyId(actionId, MachineAdminAccessActionIdSchema) ? actionId : null;
      if (machineAdminAccessActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_ADMIN_ACCESS_ACTION_INPUT_SCHEMAS)[typeof machineAdminAccessActionId]>;
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineAdminAccessAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineAdminAccessAction({ actionId: machineAdminAccessActionId, input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const machineAgentIsolationActionId = isActionFamilyId(actionId, MachineAgentIsolationActionIdSchema) ? actionId : null;
      if (machineAgentIsolationActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS)[typeof machineAgentIsolationActionId]>;
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineAgentIsolationAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineAgentIsolationAction({ actionId: machineAgentIsolationActionId, input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const machineGuardActionId = isActionFamilyId(actionId, MachineGuardActionIdSchema) ? actionId : null;
      if (machineGuardActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_GUARD_ACTION_INPUT_SCHEMAS)[typeof machineGuardActionId]>;
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineGuardAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineGuardAction({ actionId: machineGuardActionId, input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(machineGuardActionId === 'machines.guard.activity.undo' ? {
            executeCanonicalAction: (nestedActionId: ActionId, nestedInput: unknown) => {
              const request = readRecord(nestedInput);
              if (request.serverId !== undefined && !isSameHome(request.serverId, input.serverId ?? ctx.serverId, ctx)) {
                return Promise.resolve({ ok: false as const, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' });
              }
              if (request.machineId !== undefined && request.machineId !== input.machineId) {
                return Promise.resolve({ ok: false as const, errorCode: 'machine_target_mismatch', error: 'machine_target_mismatch' });
              }
              // Approval of Undo is not approval of the receipt's original effect.
              // Retain caller authority, grants and origination, but re-enter that effect's policy.
              return executeHostChild(nestedActionId, nestedInput, { ...ctx, bypassApprovals: false, presentUserConfirmation: undefined });
            },
          } : {}),
        });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (machineResourcesActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS)[typeof machineResourcesActionId]>;
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineResourcesPolicyAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineResourcesPolicyAction({ actionId: machineResourcesActionId, input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (machineVitalsActionId !== null) {
        const input = parsed.data as z.infer<(typeof MACHINE_VITALS_ACTION_INPUT_SCHEMAS)[typeof machineVitalsActionId]>;
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) {
          return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        }
        if (!deps.machineVitalsAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const result = await deps.machineVitalsAction({ actionId: machineVitalsActionId, input, context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      const machineAccessActionId = isActionFamilyId(actionId, MachineAccessActionIdSchema) ? actionId : null;
      if (machineAccessActionId !== null) {
        if (!deps.machineAccessAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const machineTarget = readRecord(parsed.data);
        if (ctx.serverId && !isSameHome(machineTarget.serverId, ctx.serverId, ctx)) {
          return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        }
        const result = await deps.machineAccessAction({ actionId: machineAccessActionId, input: parsed.data, context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
  return null;
}

export async function dispatchMachineControls2(inv: Pick<CoreInvocation, 'deps' | 'actionId' | 'parsed' | 'ctx'> & Readonly<{
  isSameHome: (targetServerId: unknown, currentServerId: string | null | undefined, ctx: ActionExecutorContext) => boolean;
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
  machinePoolActionId: Extract<ActionId, ReturnType<typeof MachinePoolActionIdV1Schema.parse>> | null;
}>): Promise<ActionExecuteResult | null> {
  const { machinePoolActionId, deps, actionId, parsed, ctx, isSameHome, executeHostChild } = inv;
      if (machinePoolActionId !== null) {
        if (!deps.machinePoolAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        if (machinePoolActionId === 'machines.pools.resolve') {
          const request = MachinePoolResolveInputV1Schema.parse(parsed.data);
          if (request.purpose === 'finite' || request.purpose === 'service-start') {
            if (ctx.serverId && !isSameHome(request.workspace.serverId, ctx.serverId, ctx)) {
              return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
            }
            const workerContext = { ...ctx, serverId: request.workspace.serverId };
            const pool = await executeHostChild('machines.pools.get', { poolId: request.poolId }, workerContext);
            if (!pool.ok) return pool;
            const result = await resolveMachinePoolWorkerCandidateV1({ request,
              pool: MachinePoolViewV1Schema.parse(pool.result),
              status: (input) => executeHostChild('projects.worker.status', input, workerContext),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            return { ok: true, result };
          }
        }
        const result = await deps.machinePoolAction({
          actionId: machinePoolActionId,
          input: MachinePoolActionInputSchemasV1[machinePoolActionId].parse(parsed.data),
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }
  return null;
}

export async function dispatchMachineControls3(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'parsed' | 'ctx'> & Readonly<{
  isSameHome: (targetServerId: unknown, currentServerId: string | null | undefined, ctx: ActionExecutorContext) => boolean;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, parsed, ctx, isSameHome } = inv;

      if ((LOCAL_DAEMON_SERVICE_ACTION_IDS as readonly string[]).includes(actionId)) {
        if (!deps.localDaemonServiceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const id = actionId as LocalDaemonServiceActionId;
        return completeActionResult(await deps.localDaemonServiceAction(id, LOCAL_DAEMON_SERVICE_INPUT_SCHEMAS[id].parse(parsed.data), ctx));
      }
      if ((MACHINE_ADD_SSH_ACTION_IDS as readonly string[]).includes(actionId)) {
        if (!deps.machineAddSshTaskAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const id = actionId as MachineAddSshActionId;
        return completeActionResult(await deps.machineAddSshTaskAction(id, MACHINE_ADD_SSH_INPUT_SCHEMAS[id].parse(parsed.data), ctx));
      }
      if (actionId === 'machines.managed.bootstrap.respond') {
        if (!deps.machineManagedInstallationRespond) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machineManagedInstallationRespond(MachineManagedInstallationRespondInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'homes.connect') {
        if (!deps.homeConnect) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.homeConnect(HomeConnectInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'homes.reconnect') {
        if (!deps.homeReconnect) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.homeReconnect(HomeReconnectInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'machines.add.local.start') {
        if (!deps.machineAddLocalStart) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machineAddLocalStart(MachineAddLocalStartInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'machines.add.local.cancel') {
        if (!deps.machineAddLocalCancel) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machineAddLocalCancel(parsed.data as AdmittedActionInputById['machines.add.local.cancel'], ctx));
      }
      if (actionId === 'machines.add.command') {
        if (!deps.machineAddCommand) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machineAddCommand(MachineAddCommandInputSchema.parse(parsed.data), ctx));
      }
      if (actionId === 'machines.pairing.create') {
        if (!deps.machinePairingCreate) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machinePairingCreate(MachinePairingCreateInputSchema.parse(parsed.data), ctx));
      }
      if ((MACHINE_PAGE_ACTION_IDS as readonly string[]).includes(actionId)) {
        const id = actionId as MachinePageActionId;
        const input = MACHINE_PAGE_ACTION_INPUT_SCHEMAS[id].parse(parsed.data);
        if (ctx.serverId && input.serverId && !isSameHome(input.serverId, ctx.serverId, ctx)) {
          return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        }
        if (!deps.machinePageAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machinePageAction({ actionId: id, input, context: ctx }));
      }
      if (isMachineTerminalActionId(actionId)) {
        const request = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId].parse(parsed.data);
        if (ctx.serverId && !isSameHome(request.serverId, ctx.serverId, ctx)) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        if (!deps.machineTerminalAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        return completeActionResult(await deps.machineTerminalAction({ actionId, input: request, context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
      }
  return null;
}
