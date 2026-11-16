import { z } from 'zod';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../../plugins/actions/jsonSchemaValidation.js';
import { MachineRecipeV1Schema, MachineRecipeSelectionV1Schema, MachineSetupPreparationBasisV1Schema, MachineSetupBoundTargetBasisV1Schema,
    machineRecipeInputConstraintsSatisfiedV1, machineRecipeStepRequiresMachineContextV1, type MachineRecipeV1 } from './machineRecipeV1.js';

/** Inspect declared credential inputs, never arbitrary script/configuration strings. */
export function isMachineRecipePreparationSuitableV1(recipe: MachineRecipeV1): boolean {
    return !recipe.inputHints?.fields.some(field => field.inputType !== undefined)
        && ![...recipe.steps, ...(recipe.removeSteps ?? [])].some(step =>
            step.kind === 'file' && step.content?.kind === 'secretGrant')
        && ![...(recipe.checks ?? []), ...recipe.steps, ...(recipe.removeSteps ?? [])].some(machineRecipeStepRequiresMachineContextV1);
}

export const MachineSetupRecipeProgramV1Schema = z.object({
    recipe: MachineRecipeV1Schema,
    selection: MachineRecipeSelectionV1Schema,
}).strict().superRefine(({ recipe, selection }, context) => {
    if (recipe.id !== selection.ref.recipeId || recipe.revision !== selection.ref.revision
        || !isValidPluginJsonSchemaValue(compilePluginJsonSchema(recipe.inputSchema), selection.inputs)
        || !machineRecipeInputConstraintsSatisfiedV1(recipe, selection.inputs)) context.addIssue({ code: 'custom', path: ['selection'],
        message: 'Setup requires the exact validated recipe selection' });
});
export type MachineSetupRecipeProgramV1 = z.infer<typeof MachineSetupRecipeProgramV1Schema>;
export const MachineSetupPreparationRecipeV1Schema = MachineSetupRecipeProgramV1Schema.superRefine(({ recipe }, context) => {
    if (!isMachineRecipePreparationSuitableV1(recipe)) context.addIssue({ code: 'custom', path: ['recipe'],
        message: 'Image preparation requires recipes independent of credentials and enrolled Machine context' });
});
/** Native Check for an admitted bound Session; declarations and target observations stay private. */
export const MachineSetupBoundRecipeCheckV1Schema = z.object({
    basis: MachineSetupBoundTargetBasisV1Schema,
    recipes: z.array(MachineSetupRecipeProgramV1Schema),
}).strict();
export type MachineSetupBoundRecipeCheckV1 = z.infer<typeof MachineSetupBoundRecipeCheckV1Schema>;
export type MachineSetupPreparationRecipeV1 = z.infer<typeof MachineSetupPreparationRecipeV1Schema>;

/** Private root stdin operand. It contains no online identity, grants or daemon facts. */
export const MachineSetupPreparationV1Schema = z.object({
    basis: MachineSetupPreparationBasisV1Schema,
    recipes: z.array(MachineSetupPreparationRecipeV1Schema),
}).strict();
export type MachineSetupPreparationV1 = z.infer<typeof MachineSetupPreparationV1Schema>;
