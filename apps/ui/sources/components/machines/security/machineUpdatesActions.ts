import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const execute = createFrontDoorActionExecute();
type Context = Omit<NonNullable<Parameters<typeof execute>[2]>, 'surface' | 'serverId'>;
export type MachineUpdatesTarget = Readonly<{ serverId: string; homeId: string; machineId: string }>;
export type MachineUpdatesScope = 'security' | 'all';

/** Read/check and exact effect preparation share the canonical setup Plan Action. */
export function planMachineUpdates(target: MachineUpdatesTarget, scope: MachineUpdatesScope, mode: 'check' | 'effects', context?: Context) {
  return execute('machines.setup.plan', { homeId: target.homeId, machineId: target.machineId, updates: { scope }, mode }, {
    ...context, surface: 'ui', serverId: target.serverId,
  });
}

/** Preserve the public approval/progress/refusal envelope for the reviewed native plan. */
export function applyMachineUpdates(target: MachineUpdatesTarget, scope: MachineUpdatesScope, plan: MachineSetupEffectPlanV1, context?: Context) {
  return execute('machines.setup.updates.apply', { homeId: target.homeId, machineId: target.machineId, scope, plan }, {
    ...context, surface: 'ui', serverId: target.serverId,
  });
}
