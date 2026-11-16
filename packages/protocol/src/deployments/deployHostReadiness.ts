import type { MachinePresetItemV1 } from '../machines/managed/machineSetupV1.js';
import type { MachineSetupApplyInputV1, MachineSetupCombinedPlanResultV1, MachineSetupPlanResultV1 } from '../machines/managed/actionsV1.js';
import { DOCKER_ENGINE_RECIPE_REF_V1 } from '../machines/setup/machineRecipeReferenceV1.js';

/**
 * The Docker host software a Machine needs before it runs a Compose Environment: the bundled recipe's own
 * selection (the protocol's `DOCKER_ENGINE_RECIPE_REF_V1`, which the recipes plugin declares), planned by the existing Machine setup Plan.
 */
export const DEPLOY_HOST_DOCKER_ITEM = { kind: 'softwareRecipe', selection: {
  ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: {},
} } as const satisfies MachinePresetItemV1;

export type DeployHostReadiness = 'ready' | 'needsSetup' | 'unknown';

/**
 * What the Plan says about this Machine's Docker recipe: `satisfied` passes its checks, `drifted` needs setup.
 * Anything else (unchecked, unsupported, a failed Plan) stays unknown, never ready.
 */
type HostPlan = MachineSetupCombinedPlanResultV1 | Readonly<{ ok: false }> | Readonly<{
  ok: true; input: MachineSetupApplyInputV1;
  facts: readonly Readonly<{ machineId: string; support: MachineSetupPlanResultV1['support'] }>[];
}>;

export function readDeployHostRecipe(result: HostPlan, machineId: string) {
  let plan: Pick<MachineSetupPlanResultV1, 'sources' | 'support'> | undefined;
  if ('ok' in result) {
    if (!result.ok) return undefined;
    const target = ('targets' in result.input ? result.input.targets : [result.input]).find(entry => entry.machineId === machineId);
    const facts = result.facts.find(entry => entry.machineId === machineId);
    if (target && facts) plan = { sources: target.sources, support: facts.support };
  } else {
    const target = result.targets.find(entry => entry.machineId === machineId);
    if (target && 'plan' in target) plan = target.plan;
  }
  if (!plan) return undefined;
  const { sources, support } = plan;
  return support.flatMap(row => {
    const source = sources[row.sourceIndex];
    const item = source && source.kind !== 'accountPresetOpaque' ? source.setup.items?.[row.itemIndex] : undefined;
    return item && item.kind !== 'app' && item.selection.ref.pluginId === DEPLOY_HOST_DOCKER_ITEM.selection.ref.pluginId
      && item.selection.ref.recipeId === DEPLOY_HOST_DOCKER_ITEM.selection.ref.recipeId ? [{ item, status: row.status }] : [];
  })[0];
}

export function readDeployHostReadiness(result: HostPlan, machineId: string): DeployHostReadiness {
  const status = readDeployHostRecipe(result, machineId)?.status;
  return status === 'satisfied' ? 'ready' : status === 'drifted' ? 'needsSetup' : 'unknown';
}
