import { expect, it } from 'vitest';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { PLUGIN_MANIFEST } from './manifest.js';
import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import { MachineFirewallExposureV1Schema } from '@happier-dev/protocol/machines/setup/machineFirewallV1';
import { getMachineFirewallExposureInputSchemaV1 } from '@happier-dev/plugin-sdk';

it('shares exact public/private exposure admission between cold inputs and the native interpreter', () => {
  const schema = compilePluginJsonSchema(getMachineFirewallExposureInputSchemaV1());
  const privateExposure = MachineFirewallExposureV1Schema.parse({ requirementId: 'caddy-private-origin', hostAddress: '100.96.0.4',
    hostPort: 8080, containerPort: 8080, protocol: 'tcp', exposure: 'privateNetwork', providerId: 'private-provider', networkIdentity: 'reviewed-network' });
  const publicExposure = MachineFirewallExposureV1Schema.parse({ requirementId: 'reviewed-public-http', hostAddress: '192.0.2.1',
    hostPort: 80, protocol: 'tcp', exposure: 'public' });
  for (const [value, valid] of [[privateExposure, true], [publicExposure, true],
    [{ ...privateExposure, providerId: undefined }, false], [{ ...privateExposure, networkIdentity: undefined }, false],
    [{ ...publicExposure, providerId: 'private-provider' }, false], [{ ...privateExposure, hostPort: 0 }, false],
    [{ ...publicExposure, hostAddress: 'not-an-address' }, false]] as const) {
    expect(MachineFirewallExposureV1Schema.safeParse(value).success).toBe(valid);
    expect(isValidPluginJsonSchemaValue(schema, value)).toBe(valid);
  }
});

it('publishes Caddy prerequisites with the reviewed seed and native daemon group, preserving durable state on detach', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === 'caddy');
  expect(recipe).toBeDefined();
  if (!recipe) throw new Error('Caddy prerequisites are absent');
  const seed = JSON.stringify({ admin: { listen: 'unix//run/happier-caddy/admin.sock|0660' } });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  expect(isValidPluginJsonSchemaValue(schema, { initialConfig: seed })).toBe(true);
  expect(isValidPluginJsonSchemaValue(schema, {})).toBe(false);
  expect(isValidPluginJsonSchemaValue(schema, { initialConfig: seed, daemonGroup: 'docker' })).toBe(false);
  const steps = recipe.steps.map(step => resolveMachineRecipeStepInputsV1(step, { initialConfig: seed }, { 'daemon.primaryGroup': 'native-daemon' }));
  expect(steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'directory', path: '/run/happier-caddy', group: 'native-daemon', mode: 0o750 }),
    expect.objectContaining({ kind: 'file', path: '/var/lib/happier/caddy/initial.json', group: 'native-daemon', mode: 0o640,
      content: { kind: 'literal', value: seed } }),
  ]));
  expect(recipe.removeSteps).toBeUndefined();
});

it('publishes the reviewed firewall candidate without inventing a policy or public-port default', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === 'firewall');
  expect(recipe).toBeDefined();
  if (!recipe) throw new Error('Firewall declaration is absent');
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  expect(isValidPluginJsonSchemaValue(schema, {})).toBe(false);
  const inputs = { rules: 'table inet happier\ndelete table inet happier\ntable inet happier { chain input { type filter hook input priority filter - 10; policy accept; } }', exposures: [] };
  expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(true);
  expect(recipe.steps.map(step => resolveMachineRecipeStepInputsV1(step, inputs))).toMatchObject([
    { kind: 'firewall', rules: inputs.rules, exposures: [] },
  ]);
  expect(recipe.removeSteps).toBeUndefined();
});

it('passes firewall candidates to the native owner which refuses a foreign-table escape before native effects', async () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === 'firewall');
  expect(recipe).toBeDefined();
  if (!recipe) throw new Error('Firewall declaration is absent');
  const inputs = { rules: 'table inet happier\ndelete table inet happier\ntable inet happier {}\nflush ruleset', exposures: [] };
  const step = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, inputs);
  const backend = createMachineSetupNativeBackend({ platform: 'linux', readNativeInit: async () => 'systemd',
    run: async () => { throw new Error('A refused firewall candidate must not execute a native command'); } });
  expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'validation_failed' });
});

it.each(['darwin', 'win32'] as const)('keeps Linux host prerequisites explicitly unsupported on %s without native effects', async platform => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const backend = createMachineSetupNativeBackend({ platform,
    run: async () => { throw new Error('Unsupported host prerequisites must not execute a native command'); } });
  for (const id of ['caddy', 'firewall']) {
    const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === id);
    expect(recipe).toBeDefined();
    if (!recipe) throw new Error('Host prerequisite declaration is absent');
    for (const declaration of recipe.steps) {
      const step = resolveMachineRecipeStepInputsV1(declaration, { initialConfig: '{}', rules: 'table inet happier {}', exposures: [] },
        { 'daemon.primaryGroup': 'native-daemon' });
      expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', reason: expect.any(String) });
    }
  }
});
