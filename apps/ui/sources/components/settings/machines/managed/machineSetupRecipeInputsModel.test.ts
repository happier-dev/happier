import { describe, expect, it } from 'vitest';
import { MachineRecipeV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { readMachineSetupRecipeInputState } from './machineSetupRecipeInputsModel';

const ref = { pluginId: 'example.host', recipeId: 'journal', revision: '1' };
const recipe = { id: 'example.host/journal', pluginId: ref.pluginId, pluginVersion: '1', definition: MachineRecipeV1Schema.parse({
    id: ref.recipeId, revision: ref.revision, title: 'Journal', description: 'Keep logs within the chosen capacity.',
    inputSchema: { type: 'object', properties: { maximumUse: { type: 'string', minLength: 1 } }, required: ['maximumUse'], additionalProperties: false },
    inputHints: { fields: [{ path: 'maximumUse', title: 'Maximum disk use', widget: 'text', required: true }] }, steps: [],
}) };
const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, machineRecipesById: { [recipe.id]: recipe } };

describe('selected setup recipe input review', () => {
    it('reviews user fields without requesting a host-supplied credential or mutating the recipe declaration', () => {
        const suppliedRecipe = { ...recipe, definition: MachineRecipeV1Schema.parse({ ...recipe.definition,
            inputSchema: { type: 'object', properties: { maximumUse: { type: 'string', minLength: 1 }, senderPublicKey: { type: 'string', minLength: 1 } },
                required: ['maximumUse', 'senderPublicKey'], additionalProperties: false },
            inputHints: { fields: [{ path: 'maximumUse', title: 'Maximum disk use', widget: 'text', required: true },
                { path: 'senderPublicKey', title: 'Sender public key', widget: 'text', required: true }] },
        }) };
        const suppliedProjection = { ...projection, machineRecipesById: { [recipe.id]: suppliedRecipe } };
        const setup = { items: [{ kind: 'setupRecipe' as const, selection: { ref, inputs: { maximumUse: '2G' } } }] };
        const state = readMachineSetupRecipeInputState(setup, suppliedProjection, { suppliedInputKeys: ['senderPublicKey'] });
        expect(state.valid).toBe(true);
        expect(state.rows[0]?.fields.map(field => field.path)).toEqual(['maximumUse']);
        expect(readMachineSetupRecipeInputState({ items: [{ ...setup.items[0]!, selection: { ref, inputs: {} } }] },
            suppliedProjection, { suppliedInputKeys: ['senderPublicKey'] }).valid).toBe(false);
        expect(readMachineSetupRecipeInputState(setup, suppliedProjection).valid).toBe(false);
    });

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


it('reviews recipe inputs beside an Agent without treating the Agent as a recipe', () => {
    const selected = { kind: 'setupRecipe' as const, selection: { ref, inputs: { maximumUse: '2G' } } };
    const setup = { items: [{ kind: 'agent' as const, agentId: 'acme.coding/reviewer' }, selected] };
    expect(readMachineSetupRecipeInputState(setup, projection)).toMatchObject({ valid: true, rows: [{ index: 1 }] });
});
