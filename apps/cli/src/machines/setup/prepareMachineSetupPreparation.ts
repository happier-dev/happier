import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isMachineSetupRecipeItemV1, type MachineSetupRecipeItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { PluginProjectedMachineRecipeEntryV1 } from '@happier-dev/protocol/daemon/machineSetupProjection';
import { splitMachineSetupForPreparationV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { ManagedMachinePresetPreparationSetupV1 } from '@happier-dev/cli-common/machines/managed';
import { MachineSetupRecipeProgramV1Schema, type MachineSetupRecipeProgramV1, MachineSetupPreparationRecipeV1Schema,
    type MachineSetupPreparationV1 } from '@happier-dev/protocol/machines/setup/machineSetupPreparationV1';

/** Catalog identity, recipe kind and authored inputs are decided by this one resolver. */
export function resolveMachineSetupRecipeProgramV1(item: MachineSetupRecipeItemV1,
  recipes: readonly Pick<PluginProjectedMachineRecipeEntryV1, 'pluginId' | 'definition'>[]):
  Readonly<{ ok: true; program: MachineSetupRecipeProgramV1 }> | ActionExecuteFailure {
  const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
  const { ref } = item.selection;
  const recipe = recipes.find(entry => entry.pluginId === ref.pluginId && entry.definition.id === ref.recipeId
    && entry.definition.revision === ref.revision)?.definition;
  if (!recipe) return fail('machine_recipe_unavailable');
  if (item.kind === 'softwareRecipe' && recipe.software !== true) return fail('invalid_machine_recipe_kind');
  const program = MachineSetupRecipeProgramV1Schema.safeParse({ recipe, selection: item.selection });
  return program.success ? { ok: true, program: program.data } : fail('invalid_machine_recipe_inputs');
}

/** Capture whole recipes only. Later recipes cannot move ahead of a deferred
 * dependency; toolchain and daemon-user scripts retain their existing owner. */
export function prepareMachineSetupPreparationV1(input: Readonly<{
    operationId: string;
    setup: MachineSetupV1;
    recipes: readonly Pick<PluginProjectedMachineRecipeEntryV1, 'pluginId' | 'definition'>[];
}>): ManagedMachinePresetPreparationSetupV1 {
    const recipes: MachineSetupPreparationV1['recipes'] = [];
    for (const item of input.setup.items ?? []) {
        if (!isMachineSetupRecipeItemV1(item)) break;
        const resolved = resolveMachineSetupRecipeProgramV1(item, input.recipes);
        if (!resolved.ok) break;
        const candidate = MachineSetupPreparationRecipeV1Schema.safeParse(resolved.program);
        if (!candidate.success) break;
        recipes.push(candidate.data);
    }
    return {
        ...splitMachineSetupForPreparationV1(input.setup, recipes.length),
        ...(recipes.length ? {
            preparation: { basis: { kind: 'preparation' as const, operationId: input.operationId }, recipes },
        } : {}),
    };
}
