import { expect, it } from 'vitest';
import { definePlugin } from './definePlugin.js';
import { parsePluginManifest } from './manifest.js';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

it('admits the maintained public recipe hints and binds the reviewed package choice through the same declaration', async () => {
  // Keep maintained author source outside the SDK declaration program, as the
  // existing public author conformance harness does for other families.
  const examplePath = fileURLToPath(new URL('../examples/public-authoring/index.ts', import.meta.url));
  const { machineSetupAuthoring: example } = await import(pathToFileURL(examplePath).href);
  const parsed = parsePluginManifest(example.manifest);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('Expected the maintained Machine setup author declaration');
  const recipe = parsed.manifest.contributes.machineRecipes[0];
  const item = parsed.manifest.contributes.machineSetupPresets[0]?.setup.items?.[0];
  if (!recipe || item?.kind !== 'softwareRecipe') throw new Error('Expected the declared recipe selection');
  expect(recipe.inputHints?.fields[0]).toMatchObject({ path: 'identity.name', widget: 'text', required: true });
  expect(recipe.steps[0]?.kind === 'package' && recipe.steps[0].packages).toEqual([{ kind: 'input', path: 'identity' }]);
  expect(resolveMachineRecipeStepInputsV1(recipe.steps[0]!, item.selection.inputs)).toMatchObject({
    kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }],
  });
  expect(parsed.manifest.contributes.machineSetupPresets.find(preset => preset.id === 'ordered-scripts')?.setup.scripts).toEqual([
    { body: '\r\necho Browser tools ready\r\n', affects: 'none' },
    { body: 'echo Browser setup checked\n', affects: 'none',
      check: { executable: 'test', args: ['-f', '/tmp/browser-setup-ready'], unsatisfiedExitCodes: [1] } },
  ]);
  expect(derivePluginDaemonContributionRegistrationRights(parsed.manifest.contributes)).toEqual([]);
});

it('authors both Machine setup data families without executable registration', () => {
  const pluginId = 'com.example.machine-setup';
  const recipe = { revision: '1', title: 'Fonts', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }] } as const;
  const preset = { revision: '1', title: 'Browser bot', description: 'Fonts for bot tools', setup: { items: [{
    kind: 'softwareRecipe', selection: { ref: { pluginId, recipeId: 'fonts', revision: '1' }, inputs: {} },
  }] } } as const;
  const plugin = definePlugin({ id: pluginId, version: '1.0.0',
    machineRecipes: { fonts: recipe },
    machineSetupPresets: { 'browser-bot': preset },
  });
  const parsed = parsePluginManifest(plugin.manifest);
  expect(parsed).toMatchObject({ ok: true, manifest: { contributes: {
    machineRecipes: [{ id: 'fonts', revision: '1' }], machineSetupPresets: [{ id: 'browser-bot', revision: '1' }],
  } } });
  if (!parsed.ok) throw new Error('Expected admitted Machine setup author declarations');
  expect(derivePluginDaemonContributionRegistrationRights(parsed.manifest.contributes)).toEqual([]);
});

it('authors input-bound Machine declarations and ordered native conditions through the public recipe contract', () => {
  const plugin = definePlugin({ id: 'com.example.machine-bindings', version: '1.0.0', machineRecipes: {
    receiver: { revision: '1', title: 'Restricted receiver',
      inputSchema: { type: 'object', properties: {
        username: { type: 'string' }, keyPath: { type: 'string' }, senderPublicKey: { type: 'string' },
      }, required: ['username', 'keyPath', 'senderPublicKey'], additionalProperties: false },
      steps: [
        { id: 'receiver', kind: 'user', username: { kind: 'input', path: 'username' }, locked: true },
        { id: 'sender-key', kind: 'file', path: { kind: 'input', path: 'keyPath' }, owner: { kind: 'input', path: 'username' },
          group: 'root', mode: 0o600, content: { kind: 'template', value: 'restrict {senderKey}\n',
            variables: { senderKey: { kind: 'input', path: 'senderPublicKey' } } } },
      ],
    },
    emulation: { revision: '1', title: 'Emulation', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      checks: [
        { id: 'working', kind: 'command', executable: '/usr/sbin/update-binfmts', args: ['--display'],
          check: { executable: '/usr/sbin/update-binfmts', args: ['--display'], unsatisfiedExitCodes: [1] } },
        { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'qemu-user-static' }] },
      ],
      steps: [{ id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'qemu-user-static' }],
        when: [{ checkId: 'working', status: ['drifted'] }, { checkId: 'package', status: ['satisfied', 'drifted'] }] }],
    },
  } });
  const parsed = parsePluginManifest(plugin.manifest);
  expect(parsed).toMatchObject({ ok: true, manifest: { contributes: { machineRecipes: [
    { id: 'receiver', steps: [{ username: { kind: 'input', path: 'username' } },
      { content: { kind: 'template', value: 'restrict {senderKey}\n', variables: { senderKey: { kind: 'input', path: 'senderPublicKey' } } } }] },
    { id: 'emulation', checks: [{ id: 'working' }, { id: 'package' }],
      steps: [{ when: [{ checkId: 'working', status: ['drifted'] }, { checkId: 'package', status: ['satisfied', 'drifted'] }] }] },
  ] } } });
  if (!parsed.ok) throw new Error('Expected admitted input-bound Machine declarations');
  expect(derivePluginDaemonContributionRegistrationRights(parsed.manifest.contributes)).toEqual([]);
});
