import { expect, it } from 'vitest';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { PLUGIN_MANIFEST } from './manifest.js';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { installPackage } from './installPackage.js';
import { googleChrome } from './googleChrome.js';
import { evaluateInputPredicate } from '@happier-dev/protocol/inputs/inputPredicates';

it('publishes exact-package software and the bot-owned browser bundle through the existing data families', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  expect(parsed.manifest.contributes.machineRecipes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'install-package', revision: '1', software: true }),
    expect.objectContaining({ id: 'google-chrome', revision: '1', software: true }),
  ]));
  expect(parsed.manifest.contributes.machineSetupPresets).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'browser-bot-v1', setup: { items: [
      { kind: 'softwareRecipe', selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' }, inputs: {} } },
      { kind: 'softwareRecipe', selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'fonts', revision: '1' }, inputs: {} } },
    ] } }),
  ]));
});

it('admits exact native identities and pins, rejecting empty, ambiguous and executable inputs before native probing', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'install-package', ...installPackage });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  for (const input of [
    { apt: [{ name: 'jq', version: '1.7.1-1' }] },
    { dnf: [{ name: 'jq', version: '1.7.1-1.fc41' }] },
    { brew: [{ name: 'google-chrome', kind: 'cask', version: '140.0.7339.127' }] },
    { brew: [{ name: 'jq', kind: 'formula' }] },
    { winget: [{ name: 'Google.Chrome', source: 'winget', scope: 'user' }] },
    { package: { manager: 'apt', apt: { name: 'jq' } } },
    { package: { manager: 'dnf', dnf: { name: 'jq', version: '1.7.1-1.fc41' } } },
    { package: { manager: 'brew', brew: { name: 'jq', kind: 'formula' } } },
    { package: { manager: 'winget', winget: { name: 'Google.Chrome' } } },
    { package: { manager: 'apt', apt: { name: 'jq' }, brew: { name: '', version: '' } } },
  ]) expect(isValidPluginJsonSchemaValue(schema, input)).toBe(true);
  for (const input of [{}, { apt: [] }, { brew: [{ name: 'jq' }] },
    { winget: [{ name: 'Google Chrome', source: 'winget', scope: 'user' }] },
    { winget: [{ name: 'Google.Chrome', scope: 'user' }] },
    { apt: [{ name: '--option' }] }, { apt: [{ name: 'jq', version: '1;native-command' }] },
    { apt: [{ name: 'jq', executable: 'native-command' }] }, { command: 'native-command' },
    { package: { manager: 'apt', apt: { name: 'jq' } }, apt: [{ name: 'jq' }] },
    { package: { apt: { name: 'jq' } } },
    { package: { manager: 'brew', brew: { name: 'jq' } } },
    { package: { manager: 'apt', apt: { name: 'jq', kind: 'formula' } } },
    { package: { manager: 'apt', apt: { name: 'jq', version: '1;native-command' } } },
  ]) expect(isValidPluginJsonSchemaValue(schema, input)).toBe(false);
});

it('declares exact native removals, including formula/cask and source/scope, without cleanup or service effects', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'install-package', ...installPackage });
  const inputs = { apt: [{ name: 'jq', version: '1.7.1' }], dnf: [{ name: 'jq' }],
    brew: [{ name: 'google-chrome', kind: 'cask' }], winget: [{ name: 'Google.Chrome', source: 'winget', scope: 'user' }] };
  expect(recipe.removeSteps?.filter(step => step.when?.every(condition => !('input' in condition)
    || evaluateInputPredicate(condition.input, inputs)) ?? true).map(step => resolveMachineRecipeStepInputsV1(step, inputs))).toEqual([
    { id: 'packages-apt', kind: 'package', manager: 'apt', state: 'absent', packages: inputs.apt },
    { id: 'packages-dnf', kind: 'package', manager: 'dnf', state: 'absent', packages: inputs.dnf },
    { id: 'packages-brew', kind: 'package', manager: 'brew', state: 'absent', packages: inputs.brew },
    { id: 'packages-winget', kind: 'package', manager: 'winget', state: 'absent', packages: inputs.winget },
  ]);
  const chrome = MachineRecipeV1Schema.parse({ id: 'google-chrome', ...googleChrome });
  expect(chrome.steps.every(step => step.kind === 'package')).toBe(true);
  expect(chrome.removeSteps?.every(step => step.kind === 'package' && step.state === 'absent')).toBe(true);
});
