import { RPC_METHODS } from '../../rpc/methods.js';
import { readRecord } from '../../inputs/inputRecords.js';

export const MANAGED_ACTIVITY_READ_RPC_METHOD = 'managed.activity.read';
export const MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD = 'managed.admission.drain.confirm';

export const MACHINE_SETUP_APPLY_ACTION_ID_V1 = 'machines.setup.apply';
export const MACHINE_SETUP_REMOVE_ACTION_ID_V1 = 'machines.setup.remove';

/** The ordinary spawn reviews these finite setup effects before starting its Agent. */
export const SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 = {
  plan: { action: 'machines.setup.plan', role: 'session_spawn_setup_plan' },
  apply: { action: MACHINE_SETUP_APPLY_ACTION_ID_V1, role: 'session_spawn_setup_apply' },
} as const;

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

export const MANAGED_MACHINE_ACTION_IDS_V1 = [
  'machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options',
  'machines.managed.acquire', 'machines.managed.list', 'machines.managed.get', 'machines.managed.birth.get', 'machines.managed.references.get',
  'machines.managed.inspect', 'machines.managed.bootstrap.retry', 'machines.managed.cancel',
  'machines.managed.credentials.install',
  'machines.managed.setup.skip', 'machines.setup.plan', MACHINE_SETUP_APPLY_ACTION_ID_V1, MACHINE_SETUP_REMOVE_ACTION_ID_V1, 'machines.setup.updates.apply',
  'machines.managed.power.set', 'machines.managed.rebuild', 'machines.managed.retention.update', 'machines.managed.delete',
  'machines.managed.controller.update', 'machines.managed.retire',
] as const;
export type ManagedMachineActionIdV1 = typeof MANAGED_MACHINE_ACTION_IDS_V1[number];

/** Executor location only; Home owns authorization for each invocation. */
export function isManagedRetainedControlInvocation(actionId: string, input: unknown): actionId is
  'machines.managed.inspect' | 'machines.managed.bootstrap.retry' | 'machines.managed.power.set' | 'machines.managed.delete' {
  return actionId === 'machines.managed.inspect' || actionId === 'machines.managed.bootstrap.retry'
    || (actionId === 'machines.managed.power.set' || actionId === 'machines.managed.delete') && readRecord(input).when === 'now';
}

/** Reviewed combined setup reads retain the parent root, never a generic child permission. */
export function isMachineSetupPlanRpcChildV1(input: Readonly<{
  rootActionId?: string; effectActionId?: string; method?: string;
}>): boolean {
  return (input.rootActionId === 'machines.setup.plan' || input.rootActionId === 'machines.setup.apply'
    || input.rootActionId === 'machines.setup.remove')
    && input.effectActionId === 'machines.setup.plan' && input.method === RPC_METHODS.MACHINE_SETUP_PLAN;
}
