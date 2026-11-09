import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { machineRecipeInputConstraintsSatisfiedV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { omitBlankSoftwareInputs, readSoftwareInputFields } from '@/components/store/StoreSoftwareInputs';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

/** Selected recipes reuse their own schema and Action fields; absent declarations remain the native Plan's decision. */
export function readMachineSetupRecipeInputState(setup: MachineSetupV1, projection: PluginUiProjectionModel | null) {
    const rows = (setup.items ?? []).flatMap((item, index) => {
        if (item.kind === 'app') return [];
        const ref = item.selection.ref;
        const recipe = projection?.machineRecipesById[`${ref.pluginId}/${ref.recipeId}`];
        if (!recipe || recipe.definition.revision !== ref.revision) return [];
        const input = typeof item.selection.inputs === 'object' && item.selection.inputs !== null && !Array.isArray(item.selection.inputs)
            ? item.selection.inputs : {};
        const hints = normalizePluginActionInputHintsV2(recipe.definition.inputHints, recipe.definition.inputSchema);
        const form = readSoftwareInputFields(hints, input);
        const inputs = typeof item.selection.inputs === 'object' && item.selection.inputs !== null && !Array.isArray(item.selection.inputs)
            ? omitBlankSoftwareInputs(input) ?? {} : item.selection.inputs;
        const valid = form.missing === null && createPluginJsonSchemaZodValueAdapter(recipe.definition.inputSchema).safeParse(inputs).success
            && machineRecipeInputConstraintsSatisfiedV1(recipe.definition, inputs);
        return [{ index, recipe, input, ...form, valid }];
    });
    return { valid: rows.every(row => row.valid), rows };
}
