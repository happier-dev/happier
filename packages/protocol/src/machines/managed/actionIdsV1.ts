import { RPC_METHODS } from '../../rpc/methods.js';
export const MANAGED_ACTIVITY_READ_RPC_METHOD = 'managed.activity.read';
export const MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD = 'managed.admission.drain.confirm';

export const MANAGED_MACHINE_ACTION_IDS_V1 = [
  'machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options',
  'machines.managed.acquire', 'machines.managed.list', 'machines.managed.get', 'machines.managed.references.get',
  'machines.managed.inspect', 'machines.managed.bootstrap.retry', 'machines.managed.cancel',
  'machines.managed.credentials.install',
  'machines.managed.setup.skip', 'machines.environment.apply', 'machines.setup.plan', 'machines.setup.apply', 'machines.setup.remove', 'machines.setup.updates.apply',
  'machines.managed.power.set', 'machines.managed.rebuild', 'machines.managed.retention.update', 'machines.managed.delete',
  'machines.managed.controller.update', 'machines.managed.retire',
] as const;
export type ManagedMachineActionIdV1 = typeof MANAGED_MACHINE_ACTION_IDS_V1[number];

export function isMachineSetupPlanRpcChildV1(input: Readonly<{
  rootActionId?: string; effectActionId?: string; method?: string;
}>): boolean {
  return (input.rootActionId === 'machines.setup.plan' || input.rootActionId === 'machines.setup.apply'
    || input.rootActionId === 'machines.setup.remove')
    && input.effectActionId === 'machines.setup.plan' && input.method === RPC_METHODS.MACHINE_SETUP_PLAN;
}
