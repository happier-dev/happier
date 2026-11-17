import { isMachineSetupRecipeItemV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { machineRecipeInputConstraintsSatisfiedV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { compilePluginJsonSchema, describePluginJsonSchemaValueIssues, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { omitBlankSoftwareInputs, readSoftwareInputFields } from '@/components/store/StoreSoftwareInputs';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

/** Selected recipes reuse their own schema and Action fields; absent declarations remain the native Plan's decision. */
export function readMachineSetupRecipeInputState(setup: MachineSetupV1, projection: PluginUiProjectionModel | null,
    options: Readonly<{ suppliedInputKeys?: readonly string[] }> = {}) {
    const supplied = new Set(options.suppliedInputKeys);
    const rows = (setup.items ?? []).flatMap((item, index) => {
        if (!isMachineSetupRecipeItemV1(item)) return [];
        const ref = item.selection.ref;
        const recipe = projection?.machineRecipesById[`${ref.pluginId}/${ref.recipeId}`];
        if (!recipe || recipe.definition.revision !== ref.revision) return [];
        const input = typeof item.selection.inputs === 'object' && item.selection.inputs !== null && !Array.isArray(item.selection.inputs)
            ? item.selection.inputs : {};
        const hints = normalizePluginActionInputHintsV2(recipe.definition.inputHints, recipe.definition.inputSchema);
        const form = readSoftwareInputFields(hints ? { ...hints, fields: hints.fields.filter(field => !supplied.has(field.path)) } : undefined, input);
        const inputs = typeof item.selection.inputs === 'object' && item.selection.inputs !== null && !Array.isArray(item.selection.inputs)
            ? omitBlankSoftwareInputs(input) ?? {} : item.selection.inputs;
        const validate = compilePluginJsonSchema(recipe.definition.inputSchema);
        const matches = isValidPluginJsonSchemaValue(validate, inputs);
        const issues = matches ? [] : describePluginJsonSchemaValueIssues(validate);
        // Host preparation fills these absent top-level inputs before native Plan.
        // Keep the original schema and every other issue authoritative in review.
        const schemaValid = matches || issues.length > 0 && issues.every(issue => [...supplied].some(key =>
            !Object.hasOwn(input, key) && issue.pointer === `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
        const valid = form.missing === null && schemaValid
            && machineRecipeInputConstraintsSatisfiedV1(recipe.definition, inputs);
        return [{ index, recipe, input, ...form, valid }];
    });
    return { valid: rows.every(row => row.valid), rows };
}
