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

it('asks the person for ports, never a written nftables candidate, and invents no open port', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === 'firewall');
  if (!recipe) throw new Error('Firewall declaration is absent');
  expect(recipe.inputHints?.fields.map(field => [field.path, field.widget])).toEqual([
    ['open.tcp', 'text_list'], ['open.udp', 'text_list'], ['open.from', 'text_list']]);
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  expect(isValidPluginJsonSchemaValue(schema, {})).toBe(false);
  expect(isValidPluginJsonSchemaValue(schema, { open: { tcp: [] } })).toBe(false);
  expect(isValidPluginJsonSchemaValue(schema, { open: { tcp: ['70000'] } })).toBe(false);
  expect(isValidPluginJsonSchemaValue(schema, { open: { tcp: ['22'], from: ['example.com'] } })).toBe(false);
  expect(recipe.removeSteps).toHaveLength(1);
});

it('lowers opened ports to the exact owned table and the review\'s public ports', () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === 'firewall');
  if (!recipe) throw new Error('Firewall declaration is absent');
  const inputs = { open: { tcp: ['443', '22', '443'], udp: ['51820'] } };
  expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(recipe.inputSchema), inputs)).toBe(true);
  const step = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, inputs);
  if (step.kind !== 'firewall') throw new Error('Firewall step expected');
  expect(step.rules.split('\n')).toEqual(expect.arrayContaining([
    '    meta nfproto ipv4 tcp dport 22 accept', '    meta nfproto ipv6 tcp dport 443 accept',
    '    meta nfproto ipv4 udp dport 51820 accept', '    ct state new drop',
    '    meta l4proto tcp meta nfproto ipv4 ct original proto-dst 443 accept',
    '    ct state new ct direction original ct status dnat drop']));
  expect(step.rules.match(/tcp dport 443 accept/g)).toHaveLength(2);
  expect(step.exposures?.map(exposure => [exposure.protocol, exposure.hostPort, exposure.exposure]))
    .toEqual([['tcp', 22, 'public'], ['tcp', 443, 'public'], ['udp', 51820, 'public']]);
  const sourced = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { open: { tcp: ['22'], from: ['203.0.113.4/32', '2001:db8::/32'] } });
  if (sourced.kind !== 'firewall') throw new Error('Firewall step expected');
  expect(sourced.rules).toContain('    ip saddr 203.0.113.4/32 tcp dport 22 accept\n    ip6 saddr 2001:db8::/32 tcp dport 22 accept\n');
  expect(sourced.rules).not.toContain('meta nfproto ipv4 tcp dport 22');
});

it('hands only rendered tables to the native owner, which accepts them; typed text never becomes a rule', async () => {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error('First-party recipe declaration was refused');
  const recipe = parsed.manifest.contributes.machineRecipes?.find(entry => entry.id === 'firewall');
  if (!recipe) throw new Error('Firewall declaration is absent');
  expect(() => resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { open: { tcp: ['22 } flush ruleset'] } }))
    .toThrow('invalid_machine_recipe_inputs');
  const step = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { open: { tcp: ['22'], from: ['10.0.0.0/8'] } });
  const backend = createMachineSetupNativeBackend({ platform: 'linux', readNativeInit: async () => 'systemd',
    run: async () => ({ code: 0, stdout: '', stderr: '', errorCode: 'ENOENT' }) });
  // Confinement passes; the host only lacks nft, so the owner reports that instead of a validation refusal.
  expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', facts: { requiredFact: 'systemNft' } });
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
      const step = resolveMachineRecipeStepInputsV1(declaration, { initialConfig: '{}', open: { tcp: ['22'] } },
        { 'daemon.primaryGroup': 'native-daemon' });
      expect(await backend.observe(step)).toMatchObject({ status: 'unsupported', reason: expect.any(String) });
    }
  }
});
