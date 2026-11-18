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
  const inputs = { mode: 'rootless', daemonConfig: {} };
  const facts = { 'daemon.username': 'happier' };
  expect(isValidPluginJsonSchemaValue(schema, inputs)).toBe(true);
  expect(isValidPluginJsonSchemaValue(schema, { mode: 'rootless', daemonConfig: { icc: false } })).toBe(false);
  expect(isValidPluginJsonSchemaValue(schema, { mode: 'group', daemonConfig: {} })).toBe(true);
  const launcher = recipe.steps.find(step => step.id === 'docker-rootless-launcher');
  const linger = recipe.steps.find(step => step.id === 'docker-rootless-linger');
  const install = recipe.steps.find(step => step.id === 'docker-rootless-install');
  if (!launcher || !linger || !install) throw new Error('Missing rootless setup declaration');

  const resolvedLauncher = resolveMachineRecipeStepInputsV1(launcher, inputs, facts);
  if (resolvedLauncher.kind !== 'file' || resolvedLauncher.content?.kind !== 'literal') {
    throw new Error('Expected literal rootless launcher');
  }
  expect(resolvedLauncher.content.value).toContain("username='happier'\n");
  expect(resolvedLauncher.content.value).toContain('{{range .SecurityOptions}}{{println .}}{{end}}');
  expect(resolvedLauncher.content.value).toContain('flags=(unconfined) {\\n  userns,\\n}');
  expect(resolveMachineRecipeStepInputsV1(linger, inputs, facts)).toMatchObject({
    kind: 'command', args: ['enable-linger', 'happier'], check: { args: ['-f', '/var/lib/systemd/linger/happier'] },
  });
  expect(resolveMachineRecipeStepInputsV1(install, inputs, facts))
    .toMatchObject({ kind: 'script', shell: 'sh', body: '/usr/local/bin/happier-docker-rootless\n' });
});

it('asks for the access mode as a choice and lets the recommended rootless mode install without daemon settings', async () => {
  const { normalizePluginActionInputHintsV2 } = await import('@happier-dev/protocol/plugins/actions/v2');
  const { resolveEffectiveActionInputFields } = await import('@happier-dev/protocol/actions/actionInputHintsRuntime');
  const recipe = MachineRecipeV1Schema.parse({ id: 'docker-engine', ...dockerEngine });
  const schema = compilePluginJsonSchema(recipe.inputSchema);
  const hints = normalizePluginActionInputHintsV2(recipe.inputHints, recipe.inputSchema);
  const visible = (draft: Record<string, unknown>) =>
    resolveEffectiveActionInputFields({ inputHints: hints }, draft).filter(field => field.visible);
  const mode = visible({}).find(field => field.path === 'mode');
  expect(mode).toMatchObject({ widget: 'select' });
  expect(mode?.options?.map(option => option.value)).toEqual(['rootless', 'group']);
  // Rootless shares no daemon settings, so the form collects only the choice and the choice alone is valid.
  expect(visible({ mode: 'rootless' }).map(field => field.path)).toEqual(['mode']);
  expect(isValidPluginJsonSchemaValue(schema, { mode: 'rootless' })).toBe(true);
  // Group access (and saved inputs without a mode) still asks for the reviewed daemon settings.
  for (const draft of [{ mode: 'group' }, {}]) {
    expect(visible(draft).find(field => field.path === 'daemonConfig')).toMatchObject({ widget: 'json', required: true });
  }
});
