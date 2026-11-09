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

it('resolves an authored whole-object merge input without writing the input-reference wrapper', () => {
  const step = { id: 'docker-daemon-config', kind: 'file' as const, path: '/etc/docker/daemon.json', owner: 'root', group: 'root', mode: 0o644,
    content: { kind: 'jsonMerge' as const, value: { kind: 'input', path: 'daemonConfig' } } };
  expect(resolveMachineRecipeStepInputsV1(step, { daemonConfig: { icc: false } })).toMatchObject({
    content: { kind: 'jsonMerge', value: { icc: false } },
  });
});
