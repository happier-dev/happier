import type { MachineReachabilityChangeV1, MachineReachabilityPlanV1 } from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { buildNetworkConfigureInput, buildNetworkInspectInput } from './networkSurface';

const execute = createFrontDoorActionExecute();
type Context = Omit<NonNullable<Parameters<typeof execute>[2]>, 'surface' | 'serverId'>;
type Target = Readonly<{ serverId: string; machineId: string }>;

/** Preserve the public envelope, including pending approval, typed refusal and unknown outcomes. */
export function inspectMachineNetwork(target: Target, change?: MachineReachabilityChangeV1, context?: Context): Promise<ActionExecuteResult> {
  return execute('machines.reachability.inspect', buildNetworkInspectInput(target, change), {
    ...context, surface: 'ui', serverId: target.serverId,
  });
}

/** The shared Action owner decides policy and progress for the exact reviewed change. */
export function configureMachineNetwork(serverId: string, plan: MachineReachabilityPlanV1, context?: Context): Promise<ActionExecuteResult> {
  return execute('machines.reachability.configure', buildNetworkConfigureInput(serverId, plan), {
    ...context, surface: 'ui', serverId,
  });
}
