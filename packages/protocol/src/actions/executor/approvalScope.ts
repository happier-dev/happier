import { MachineServiceExecInputV1Schema } from '../specs/machine/services.js';
import type { ActionId } from '../actionIds.js';
import type { ActionEnvironmentApprovalScopeAdmissionV1 } from '../actionApprovalPolicy.js';
import type { ActionApprovalScopeV1 } from '../actionSettings.js';
import type { ActionSpec } from '../actionSpecs.js';
import { MachineServiceLogsReadInputV1Schema, MachineServiceControlInputV1Schema } from '../specs/machine/services.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { ActionHomeEquivalence } from './coreInvocation.js';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from './types.js';

type ApprovalScopeAdmission = Readonly<{
  approvalScope?: ActionApprovalScopeV1;
  previewTemplateEnvironmentId?: string;
  mandatoryApprovalRequired?: true;
}>;

/** Scope comes from the admitted owner, never caller context or a policy snapshot. */
export async function readActionApprovalScopeAdmissionV1(args: Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  input: unknown;
  context: ActionExecutorContext;
  deps: ActionExecutorDeps;
  phase: 'prepare' | 'dispatch' | 'replay';
  isSameHome: ActionHomeEquivalence;
}>): Promise<ApprovalScopeAdmission | ActionExecuteFailure> {
  const { actionId, spec, input, context, deps } = args;
  if (actionId === 'machines.services.exec') {
    const request = MachineServiceExecInputV1Schema.parse(input);
    if (context.serverId && !args.isSameHome(request.serverId, context.serverId)) return wrongHome();
    // A separate public invocation cannot mint P41's live admitted parent.
    // Its host-only candidate factory consumes that same parent directly.
    if (request.target.kind !== 'current') return { ok: false,
      errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' };
    const resolved = await deps.machineServiceScope?.({ actionId, input: {
      serverId: request.serverId, machineId: request.machineId,
      serviceId: request.target.serviceId, expectedGeneration: request.target.expectedGeneration,
    }, context });
    if (!resolved) return { ok: false, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' };
    return 'ok' in resolved ? resolved : { approvalScope: resolved };
  }
  if (spec.approvalScope === 'environment') {
    if (!deps.resolveEnvironmentApprovalScope) return unavailable();
    const admission = await deps.resolveEnvironmentApprovalScope({ actionId, input, context, phase: args.phase });
    if ('ok' in admission) return admission;
    return projectEnvironmentAdmission(admission);
  }
  if (actionId === 'machines.services.logs.read' || actionId === 'machines.services.control') {
    const target = actionId === 'machines.services.control' ? MachineServiceControlInputV1Schema.parse(input) : MachineServiceLogsReadInputV1Schema.parse(input);
    if (context.serverId && !args.isSameHome(target.serverId, context.serverId)) return wrongHome();
    const resolved = await deps.machineServiceScope?.({ actionId, input: target, context });
    return resolved && 'ok' in resolved ? resolved : { ...(resolved ? { approvalScope: resolved } : {}) };
  }
  if (spec.approvalScope === 'machine') {
    const target = readRecord(input);
    if (typeof target.serverId === 'string' && context.serverId && !args.isSameHome(target.serverId, context.serverId)) return wrongHome();
    if (typeof target.machineId === 'string' && target.machineId.length > 0) {
      return { approvalScope: { kind: 'machine', machineId: target.machineId } };
    }
  }
  return {};
}

function projectEnvironmentAdmission(admission: ActionEnvironmentApprovalScopeAdmissionV1): ApprovalScopeAdmission | ActionExecuteFailure {
  if (admission.previewTemplateEnvironmentId && (!admission.scope
    || admission.scope.environmentId === admission.previewTemplateEnvironmentId)) return unavailable();
  return {
    ...(admission.scope ? { approvalScope: admission.scope } : {}),
    ...(admission.previewTemplateEnvironmentId ? { previewTemplateEnvironmentId: admission.previewTemplateEnvironmentId } : {}),
    ...(admission.mandatoryApprovalRequired ? { mandatoryApprovalRequired: true } : {}),
  };
}

function unavailable(): ActionExecuteFailure {
  return { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
}

function wrongHome(): ActionExecuteFailure {
  return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
}
