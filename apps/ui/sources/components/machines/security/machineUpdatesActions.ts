import type { MachineSetupUpdatesRolloutInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
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

type Confirmation = NonNullable<NonNullable<Parameters<typeof createFrontDoorActionExecute>[1]>['presentUserActionConfirmation']>;

/**
 * Install confirms the exact package plan already shown on this step. Preserve the public progress/refusal
 * envelope; a Machine that carries an additional review back still presents it through `confirmation`.
 */
export function applyMachineUpdates(target: MachineUpdatesTarget, scope: MachineUpdatesScope, plan: MachineSetupEffectPlanV1, context?: Context,
  confirmation?: Confirmation) {
  const dispatch = confirmation ? createFrontDoorActionExecute(undefined, { presentUserActionConfirmation: confirmation }) : execute;
  return dispatch.confirmed('machines.setup.updates.apply', { homeId: target.homeId, machineId: target.machineId, scope, plan }, {
    ...context, surface: 'ui', serverId: target.serverId,
  });
}

/** A fleet rollout installs each Machine's reviewed plan in one admitted Action, confirmed by the Roll out press. */
export function rolloutMachineUpdates(serverId: string, input: MachineSetupUpdatesRolloutInputV1, context?: Context,
  confirmation?: Confirmation) {
  const dispatch = confirmation ? createFrontDoorActionExecute(undefined, { presentUserActionConfirmation: confirmation }) : execute;
  return dispatch.confirmed('machines.setup.updates.rollout', input, { ...context, surface: 'ui', serverId });
}
