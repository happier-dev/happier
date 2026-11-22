import type { ActionId } from '../actionIds.js';
import { readExplicitActionApprovalPreferenceV1, type ActionApprovalPolicyScopeV1 } from '../actionApprovalPolicy.js';
import type { ActionsSettingsV1 } from '../actionSettings.js';
import type { ActionSpec } from '../actionSpecs.js';
import { isPresentUserHostInvocation } from '../invocationAuthority.js';
import type { AutomationSubjectContextV1 } from '../../automations/automationSubjectV1.js';
import { isDeploymentActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import { MachineServiceLogsReadInputV1Schema, MachineServiceControlInputV1Schema } from '../specs/machine/services.js';
import { MachineServiceExecInputV1Schema } from '../specs/machine/services.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { ActionHomeEquivalence } from './coreInvocation.js';
import type { ActionExecuteFailure, ActionExecutorContext, ActionExecutorDeps } from './types.js';

export type ActionApprovalScopeAdmissionV1 = Readonly<{
  approvalScope?: ActionApprovalPolicyScopeV1;
  approvalSettings?: ActionsSettingsV1;
  automationSubjects?: readonly AutomationSubjectContextV1[];
}>;

/** Exact scope comes from the admitted owner, never caller context or a policy snapshot. */
export async function readActionApprovalScopeAdmissionV1(args: Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  input: unknown;
  context: ActionExecutorContext;
  deps: ActionExecutorDeps;
  phase: 'prepare' | 'dispatch' | 'replay';
  dispatchImmediately?: boolean;
  isSameHome: ActionHomeEquivalence;
}>): Promise<ActionApprovalScopeAdmissionV1 | ActionExecuteFailure> {
  const { actionId, spec, input, context, deps } = args;
  const projection = typeof spec.approvalScope === 'object'
    ? spec.approvalScope.project?.(input, { serverId: context.serverIdentityId ?? context.serverId }) : undefined;
  const declaredScope = projection ? projection.scope : spec.approvalScope;
  const automationSubjects = projection?.subjects.map(subject => ({ role: 'operand' as const, subject }));
  const operandFacts = automationSubjects?.length ? { automationSubjects } : {};
  if (spec.approvalScope === 'environment' && spec.sideEffectClass === 'read' && spec.approvalPolicy?.uiConfirmation === 'direct'
    && spec.serverTransport?.method === 'GET' && spec.executionPlacement === 'account' && !spec.executionPlacementForInput
    && isDeploymentActionIdV1(actionId) && args.phase === 'prepare' && args.dispatchImmediately
    && context.surface === 'ui' && context.callerSurface === undefined && isPresentUserHostInvocation(context)
    && !context.approvalProfileId && !context.approvalProfile && !context.sessionApprovalConsents?.rows.length) {
    // Home admits access in each GET. Keep the exact scope for Ask and whenever
    // an Environment or its Preview template could supply a saved preference.
    const settings = deps.readActionsSettings?.(context) ?? context.actionsSettings;
    if (settings && !settings.scopedApprovalPreferences?.some(row => row.actionId === actionId
      && row.scope.kind === 'environment')
      && readExplicitActionApprovalPreferenceV1(actionId, settings, context) !== true) return { approvalSettings: settings };
  }
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
  if (declaredScope === 'environment'
    || actionId === 'deployments.environments.create' && readRecord(input).purpose === 'preview') {
    if (!deps.resolveEnvironmentApprovalScope) return unavailable();
    const admission = await deps.resolveEnvironmentApprovalScope({ actionId, input, context, phase: args.phase });
    if ('ok' in admission) return admission;
    return { ...operandFacts, ...(admission.scope ? { approvalScope: admission.scope } : {}) };
  }
  if (actionId === 'machines.services.logs.read' || actionId === 'machines.services.control') {
    const target = actionId === 'machines.services.control' ? MachineServiceControlInputV1Schema.parse(input) : MachineServiceLogsReadInputV1Schema.parse(input);
    if (context.serverId && !args.isSameHome(target.serverId, context.serverId)) return wrongHome();
    const resolved = await deps.machineServiceScope?.({ actionId, input: target, context });
    return resolved && 'ok' in resolved ? resolved : { ...(resolved ? { approvalScope: resolved } : {}) };
  }
  if (declaredScope === 'machine') {
    const target = readRecord(input);
    if (typeof target.serverId === 'string' && context.serverId && !args.isSameHome(target.serverId, context.serverId)) return wrongHome();
    if (typeof target.machineId === 'string' && target.machineId.length > 0) {
      return { ...operandFacts, approvalScope: { kind: 'machine', machineId: target.machineId } };
    }
  }
  return operandFacts;
}

function unavailable(): ActionExecuteFailure {
  return { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
}

function wrongHome(): ActionExecuteFailure {
  return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
}
