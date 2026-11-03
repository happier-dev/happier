import { expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { normalizePluginUiProjection } from './projection';
import { createPluginUiProjectionUnionPublication, mergeInstalledPluginUiProjections, unionPluginUiProjections } from './projectionUnion';

it('retains recipe declaration identity and retires both families with their supplying occurrence', () => {
  const pluginId = 'com.example.machine-setup';
  const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_setup',
    sourceRef: { machineId: 'supplier', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'setup-root' } } });
  const authority = { pluginId, pluginVersion: '1.0.0', occurrenceId: 'setup-occurrence', executionOrigin };
  const recipe = { ...authority, id: `${pluginId}/fonts`, definition: { id: 'fonts', revision: '1', title: 'Fonts',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [] } };
  const preset = { ...authority, id: `${pluginId}/browser-bot`, definition: { id: 'browser-bot', revision: '1', title: 'Browser bot', description: 'Fonts for bot tools', setup: {
    items: [{ kind: 'softwareRecipe', selection: { ref: { pluginId, recipeId: 'fonts', revision: '1' }, inputs: {} } }],
  } } };
  const sibling = { ...recipe, id: `${pluginId}/more-fonts`, definition: { ...recipe.definition, id: 'more-fonts' } };
  const wire = PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: { [pluginId]: {
    id: pluginId, displayName: 'Setup', version: '1.0.0', enabled: true, occurrenceId: authority.occurrenceId, executionOrigin,
    sourceCustody: { kind: 'development', registeredRootId: 'setup-root' }, source: { kind: 'path', locator: '/plugins/setup' },
  } }, familiesById: { machineRecipes: { family: 'machineRecipes', entriesById: { [recipe.id]: recipe, [sibling.id]: sibling } },
    machineSetupPresets: { family: 'machineSetupPresets', entriesById: { [preset.id]: preset } } } });
  const model = normalizePluginUiProjection(wire);
  expect(model).toMatchObject({ machineRecipesById: { [recipe.id]: recipe }, machineSetupPresetsById: { [preset.id]: preset } });
  expect(normalizePluginUiProjection(wire, 'web', model, { previousInput: wire })).toBe(model);
  const equal = PluginProjectionV2Schema.parse(structuredClone(wire));
  expect(normalizePluginUiProjection(equal, 'web', model, { previousInput: wire })).toBe(model);
  const changed = PluginProjectionV2Schema.parse({ ...equal, generation: 2, familiesById: { ...equal.familiesById,
    machineRecipes: { family: 'machineRecipes', entriesById: { ...equal.familiesById.machineRecipes!.entriesById,
      [recipe.id]: { ...recipe, definition: { ...recipe.definition, title: 'Updated fonts' } },
    } },
  } });
  const updated = normalizePluginUiProjection(changed, 'web', model, { previousInput: wire });
  expect(updated.machineRecipesById[recipe.id]).not.toBe(model.machineRecipesById[recipe.id]);
  expect(updated.machineRecipesById[sibling.id]).toBe(model.machineRecipesById[sibling.id]);
  expect(updated.machineSetupPresetsById).toBe(model.machineSetupPresetsById);
  expect(mergeInstalledPluginUiProjections([model], null)).toMatchObject({ machineRecipesById: { [recipe.id]: recipe } });
  const member = { machineId: 'supplier', serverId: 'server', serverIdentityId: 'srv_setup', phase: 'current' as const, interactionEnabled: true, projection: model };
  const origins = new Map([[pluginId, executionOrigin]]);
  const union = unionPluginUiProjections([member], origins).pluginUiProjection;
  expect(union).toMatchObject({ machineRecipesById: { [recipe.id]: recipe }, machineSetupPresetsById: { [preset.id]: preset } });
  const publisher = createPluginUiProjectionUnionPublication();
  const initialPublication = publisher.publish([member], origins);
  for (let refresh = 0; refresh < 3; refresh++) {
    expect(publisher.publish([{ ...member, projection: normalizePluginUiProjection(equal, 'web', model, { previousInput: wire }) }], origins))
      .toBe(initialPublication);
  }
  const changedPublication = publisher.publish([{ ...member, projection: updated }], origins);
  expect(changedPublication).not.toBe(initialPublication);
  expect(changedPublication.pluginUiProjection?.machineRecipesById[recipe.id]?.definition.title).toBe('Updated fonts');
  expect(changedPublication.pluginUiProjection?.machineRecipesById[sibling.id])
    .toBe(initialPublication.pluginUiProjection?.machineRecipesById[sibling.id]);
  expect(changedPublication.pluginUiProjection?.machineSetupPresetsById[preset.id])
    .toBe(initialPublication.pluginUiProjection?.machineSetupPresetsById[preset.id]);
  const disabled = { ...model, installedPackagesById: { ...model.installedPackagesById, [pluginId]: { ...model.installedPackagesById[pluginId]!, enabled: false } } };
  expect(unionPluginUiProjections([{ ...member, projection: disabled }], origins).pluginUiProjection)
    .toMatchObject({ machineRecipesById: {}, machineSetupPresetsById: {} });
});
