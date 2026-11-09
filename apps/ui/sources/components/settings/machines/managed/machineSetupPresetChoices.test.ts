import { expect, it } from 'vitest';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { machineSetupPresetSource, readMachineSetupPresetChoices } from './machineSetupPresetChoices';

it('lists bundled setup declarations with saved presets and preserves their ordered unfilled recipe inputs', () => {
    const ref = { pluginId: 'example.setup', recipeId: 'firewall', revision: '1' };
    const setup = { items: [{ kind: 'setupRecipe' as const, selection: { ref, inputs: {} } },
        { kind: 'softwareRecipe' as const, selection: { ref: { ...ref, recipeId: 'fonts' }, inputs: {} } }] };
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, machineSetupPresetsById: {
        'example.setup/secure': { id: 'example.setup/secure', pluginId: 'example.setup', pluginVersion: '1',
            occurrenceId: 'occurrence', definition: { id: 'secure', revision: '2', title: 'Secure', description: 'Two recipes', setup } },
    } };
    const saved = { id: 'saved', revision: 1, name: 'Saved', homeId: 'home', owner: { kind: 'account' as const, accountId: 'owner' }, setup: {} };
    const choices = readMachineSetupPresetChoices([saved, { ...saved, id: 'archived', archivedAt: 1 }], projection,
        (_pluginId, value) => typeof value === 'string' ? value : '');
    expect(choices.map(choice => choice.name)).toEqual(['Saved', 'Secure']);
    expect(machineSetupPresetSource(choices[1]!)).toEqual({ kind: 'bundledPreset',
        ref: { pluginId: 'example.setup', localId: 'secure', revision: '2' }, setup });
    expect(machineSetupPresetSource(choices[0]!)).toEqual({ kind: 'accountPreset', presetId: 'saved', presetRevision: 1, setup: {} });
});
