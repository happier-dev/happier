import { describe, expect, it } from 'vitest';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { readMachineSetupRecipeInputState } from './machineSetupRecipeInputs';

const ref = { pluginId: 'example.host', recipeId: 'journal', revision: '1' };
const recipe = { id: 'example.host/journal', pluginId: ref.pluginId, pluginVersion: '1', definition: MachineRecipeV1Schema.parse({
    id: ref.recipeId, revision: ref.revision, title: 'Journal', description: 'Keep logs within the chosen capacity.',
    inputSchema: { type: 'object', properties: { maximumUse: { type: 'string', minLength: 1 } }, required: ['maximumUse'], additionalProperties: false },
    inputHints: { fields: [{ path: 'maximumUse', title: 'Maximum disk use', widget: 'text', required: true }] }, steps: [],
}) };
const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, machineRecipesById: { [recipe.id]: recipe } };

describe('selected setup recipe input review', () => {
    it('uses the selected pinned recipe schema to require explicit input before planning, without seeding values', () => {
        const setup = { items: [{ kind: 'setupRecipe' as const, selection: { ref, inputs: {} } }] };
        const state = readMachineSetupRecipeInputState(setup, projection);
        expect(state.valid).toBe(false);
        expect(state.rows).toMatchObject([{ index: 0, input: {}, missing: 'Maximum disk use' }]);
        expect(readMachineSetupRecipeInputState({ items: [{ ...setup.items[0]!, selection: { ref, inputs: { maximumUse: '2G' } } }] }, projection).valid).toBe(true);
        expect(setup.items[0]?.selection.inputs).toEqual({});
    });

    it('does not render another revision or an unselected recipe, leaving unknown declaration admission to the native plan', () => {
        const setup = { items: [{ kind: 'setupRecipe' as const, selection: { ref: { ...ref, revision: '2' }, inputs: {} } }] };
        expect(readMachineSetupRecipeInputState(setup, projection).rows).toEqual([]);
        expect(readMachineSetupRecipeInputState({}, projection)).toMatchObject({ valid: true, rows: [] });
    });
});
