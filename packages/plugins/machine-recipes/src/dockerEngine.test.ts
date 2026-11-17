import { expect, it } from 'vitest';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { dockerEngine } from './dockerEngine.js';

it('requires a deliberate Docker configuration choice and binds only the reviewed daemon keys', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'docker-engine', ...dockerEngine });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  const daemonConfig = { icc: false, 'no-new-privileges': true, 'log-driver': 'json-file',
    'log-opts': { 'max-size': '25m', 'max-file': '4' } };
  for (const config of [{}, daemonConfig, { icc: true }, { 'no-new-privileges': false }]) {
    const inputs = { daemonConfig: config };
    expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(true);
    const authored = recipe.steps.find(step => step.kind === 'file');
    if (!authored) throw new Error('Missing Docker daemon configuration');
    expect(resolveMachineRecipeStepInputsV1(authored, inputs)).toMatchObject({ kind: 'file',
      path: '/etc/docker/daemon.json', content: { kind: 'jsonMerge', value: config }, validate: 'docker',
      onChange: { serviceStepId: 'docker-service', action: 'restart' } });
  }
  for (const inputs of [{}, { daemonConfig: { unknown: true } }, { daemonConfig: { icc: 'false' } },
    { daemonConfig: { 'log-opts': { 'max-file': 4 } } }, { daemonConfig: { 'log-opts': { unknown: 'value' } } }]) {
    expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(false);
  }
});

it('offers rootless alongside legacy group inputs without admitting shared daemon settings in rootless mode', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'docker-engine', ...dockerEngine });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  expect(isValidPluginJsonSchemaValue(schema, { mode: 'rootless', daemonConfig: {} })).toBe(true);
  expect(isValidPluginJsonSchemaValue(schema, { mode: 'rootless', daemonConfig: { icc: false } })).toBe(false);
  expect(isValidPluginJsonSchemaValue(schema, { mode: 'group', daemonConfig: {} })).toBe(true);
  const authored = recipe.steps.find(step => step.id === 'docker-rootless-install');
  expect(authored).toBeDefined();
  if (!authored) throw new Error('Missing rootless install');
  expect(resolveMachineRecipeStepInputsV1(authored, { mode: 'rootless', daemonConfig: {} }, { 'daemon.username': 'happier' }))
    .toMatchObject({ kind: 'script', shell: 'sh', body: '/usr/local/bin/happier-docker-rootless\n' });
});
