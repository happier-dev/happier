import { RPC_METHODS } from '../../rpc/methods.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { ExternalActionExecutionAuthorizationV1, ReviewedActionChildHttpProofV1 } from '../../actions/externalActionApi.js';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '../../bots/templates/botTemplateActionIdsV1.js';
import { isSessionActionChildCreationRootV1 } from '../../sessions/creation/sessionCreationActionIdsV1.js';

export const MANAGED_ACTIVITY_READ_RPC_METHOD = 'managed.activity.read';
export const MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD = 'managed.admission.drain.confirm';

export const MACHINE_SETUP_PLAN_ACTION_ID_V1 = 'machines.setup.plan';
export const MACHINE_SETUP_APPLY_ACTION_ID_V1 = 'machines.setup.apply';
export const MACHINE_SETUP_REMOVE_ACTION_ID_V1 = 'machines.setup.remove';
export const MANAGED_RESIZE_ACTION_ID_V1 = 'machines.managed.resize';
export const MANAGED_CONTROL_ACTION_IDS_V1 = ['machines.managed.power.set', 'machines.managed.rebuild', MANAGED_RESIZE_ACTION_ID_V1,
  'machines.managed.retention.update', 'machines.managed.delete', 'machines.managed.controller.update', 'machines.managed.retire'] as const;
export type ManagedControlActionIdV1 = typeof MANAGED_CONTROL_ACTION_IDS_V1[number];
export function isManagedResizeActionIdV1(actionId: string): actionId is typeof MANAGED_RESIZE_ACTION_ID_V1 {
  return actionId === MANAGED_RESIZE_ACTION_ID_V1;
}
export function isManagedControlAdmissionActionIdV1(actionId: string): actionId is
  'machines.managed.power.set' | 'machines.managed.delete' | typeof MANAGED_RESIZE_ACTION_ID_V1 {
  return actionId === 'machines.managed.power.set' || actionId === 'machines.managed.delete' || isManagedResizeActionIdV1(actionId);
}

/** The ordinary spawn reviews these finite setup effects before starting its Agent. */
export const SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 = {
  plan: { action: MACHINE_SETUP_PLAN_ACTION_ID_V1, role: 'session_spawn_setup_plan' },
  apply: { action: MACHINE_SETUP_APPLY_ACTION_ID_V1, role: 'session_spawn_setup_apply' },
} as const;

/** Backup configuration uses the ordinary receiving Machine setup children. */
export const BACKUP_RECEIVER_SETUP_CHILDREN_V1 = {
  plan: { action: MACHINE_SETUP_PLAN_ACTION_ID_V1, role: 'backup.receiver.plan' },
  apply: { action: MACHINE_SETUP_APPLY_ACTION_ID_V1, role: 'backup.receiver.apply' },
} as const;

/** Readiness discovers first; mutating acquisition retains ordinary Manage admission. */
export const SESSION_AGENT_READINESS_ROOT_ACTION_ID_V1 = 'session.spawn_new';
export const SESSION_AGENT_READINESS_CHILDREN_V1 = {
  inventory: { action: 'machines.agents.list', role: 'session_agent_inventory' },
  acquire: { action: 'machines.agents.install', role: 'session_agent_acquire' },
  status: { action: 'machines.agents.install.status', role: 'session_agent_acquire_status' },
} as const;
export type SessionAgentReadinessActionIdV1 = typeof SESSION_AGENT_READINESS_CHILDREN_V1[keyof typeof SESSION_AGENT_READINESS_CHILDREN_V1]['action'];

export function readSessionAgentReadinessRoleV1(actionId: string): string | undefined {
  return Object.values(SESSION_AGENT_READINESS_CHILDREN_V1).find(child => child.action === actionId)?.role;
}

/** Readiness keeps the admitted Session creator's root, including nested Copy and Prepare. */
export function isSessionAgentReadinessRootActionIdV1(actionId: string): boolean {
  return actionId === SESSION_AGENT_READINESS_ROOT_ACTION_ID_V1
    || actionId === BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || isSessionActionChildCreationRootV1(actionId);
}

/** A host-reviewed readiness child retains its original selected installation. */
export function readSessionAgentReadinessChildActionV1(
  binding: ExternalActionExecutionAuthorizationV1['binding'] | undefined,
  reviewedChild: ReviewedActionChildHttpProofV1 | undefined,
  selectedTarget?: Readonly<{ machineId: string; installationId: string }>,
): SessionAgentReadinessActionIdV1 | null {
  if (!binding || !isSessionAgentReadinessRootActionIdV1(binding.actionId) || !reviewedChild
    || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
    || selectedTarget && (selectedTarget.machineId !== binding.machineId || selectedTarget.installationId !== binding.installationId)) return null;
  return Object.values(SESSION_AGENT_READINESS_CHILDREN_V1).find(child => child.action === reviewedChild.actionId
    && child.role === reviewedChild.role)?.action ?? null;
}

/** Selects ordinary setup routing; admission remains owned by the caller's reviewed-child boundary. */
export function isMachineSetupPlanOrApplyActionIdV1(actionId: string): boolean {
  return actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action
    || actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1;
}

/** Native setup roots share the ordinary Machine method/effect authorization owner. */
export function isOrdinaryMachineSetupNativeActionIdV1(actionId: string): actionId is
  'machines.setup.plan' | typeof MACHINE_SETUP_APPLY_ACTION_ID_V1 | typeof MACHINE_SETUP_REMOVE_ACTION_ID_V1 | 'machines.setup.updates.apply' {
  return isMachineSetupPlanOrApplyActionIdV1(actionId)
    || actionId === MACHINE_SETUP_REMOVE_ACTION_ID_V1 || actionId === 'machines.setup.updates.apply';
}

export const MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 = 'machines.managed.bootstrap.retry';
export const MANAGED_MACHINE_ACTION_IDS_V1 = [
  'machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options',
  'machines.managed.acquire', 'machines.managed.list', 'machines.managed.get', 'machines.managed.birth.get', 'machines.managed.references.get',
  'machines.managed.inspect', MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1, 'machines.managed.cancel',
  'machines.managed.credentials.install',
  'machines.managed.setup.skip', 'machines.setup.plan', MACHINE_SETUP_APPLY_ACTION_ID_V1, MACHINE_SETUP_REMOVE_ACTION_ID_V1, 'machines.setup.updates.apply',
  'machines.managed.power.set', 'machines.managed.rebuild', 'machines.managed.resize', 'machines.managed.retention.update', 'machines.managed.delete',
  'machines.managed.controller.update', 'machines.managed.retire',
] as const;
export type ManagedMachineActionIdV1 = typeof MANAGED_MACHINE_ACTION_IDS_V1[number];

/** Creator mutations retain the exact admitted resource and its controller. */
export const MANAGED_CREATION_MUTATION_ACTION_IDS_V1 = ['machines.managed.cancel', 'machines.managed.setup.skip'] as const;
export function isManagedCreationMutationActionIdV1(actionId: string): actionId is typeof MANAGED_CREATION_MUTATION_ACTION_IDS_V1[number] {
  return MANAGED_CREATION_MUTATION_ACTION_IDS_V1.some(id => id === actionId);
}

/** Recovery completes only the retained enrollment policy, never unrelated creation effects. */
export function isManagedEnrollmentRecoveryChildV1(rootActionId: string, childActionId: string): boolean {
  const isolation = childActionId === 'machines.agentIsolation.preview' || childActionId === 'machines.agentIsolation.set';
  return rootActionId === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 && (childActionId === 'machines.setup.adminAccess.set' || childActionId === 'machines.roles.set' || isolation)
    || rootActionId === 'machines.managed.inspect' && isolation;
}

/** Power and Delete share the admitted native-control lifecycle. */
export function isManagedPowerOrDeleteActionIdV1(actionId: string): actionId is
  'machines.managed.power.set' | 'machines.managed.delete' {
  return actionId === 'machines.managed.power.set' || actionId === 'machines.managed.delete';
}

/** Finite foreground native controls need execution authority before their first effect. */
export function isManagedAccountNativeControlInvocationV1(actionId: string, input: unknown): boolean {
  return isManagedResizeActionIdV1(actionId)
    || actionId === 'machines.managed.power.set' && readRecord(input).when === 'now';
}

/** A native control's retained-row read spends that same admitted control root. */
export function managedAccountNativeReadEffectActionIdV1(rootActionId: string, rootInput: unknown, effectActionId: string): string {
  return effectActionId === 'machines.managed.get' && isManagedAccountNativeControlInvocationV1(rootActionId, rootInput)
    ? rootActionId : effectActionId;
}

/** Deferred controls keep the same executor: its reconciler owns the idle wait. Home owns admission. */
export function isManagedRetainedControlInvocation(actionId: string, _input: unknown): actionId is
  'machines.managed.inspect' | typeof MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 | 'machines.managed.power.set' | 'machines.managed.delete' | 'machines.managed.resize'
  | typeof MANAGED_CREATION_MUTATION_ACTION_IDS_V1[number] {
  return actionId === 'machines.managed.inspect' || actionId === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1
    || isManagedCreationMutationActionIdV1(actionId)
    || actionId === 'machines.managed.resize'
    || isManagedPowerOrDeleteActionIdV1(actionId);
}

/** Reviewed combined setup reads retain the parent root, never a generic child permission. */
export function isMachineSetupPlanRpcChildV1(input: Readonly<{
  rootActionId?: string; effectActionId?: string; method?: string;
}>): boolean {
  return (input.rootActionId === 'machines.setup.plan' || input.rootActionId === 'machines.setup.apply'
    || input.rootActionId === 'machines.setup.remove')
    && input.effectActionId === 'machines.setup.plan' && input.method === RPC_METHODS.MACHINE_SETUP_PLAN;
}

/** Credential admission maps a native provisioning root to its declared role. */
export function readManagedProvisionerCredentialRootRoleV1(actionId: string): 'check' | 'options' | 'all' | null {
  if (actionId === 'machines.provisioners.check') return 'check';
  if (actionId === 'machines.provisioners.options') return 'options';
  return actionId === 'machines.managed.acquire' ? 'all' : null;
}
