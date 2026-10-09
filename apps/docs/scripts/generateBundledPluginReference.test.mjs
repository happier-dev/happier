import assert from 'node:assert/strict';
import test from 'node:test';

import {
  categorize,
  contributedFamilies,
  readBundledPluginRegistry,
  renderBundledPluginMarkdown,
  renderBundledPluginReferenceMarkdown,
} from './generateBundledPluginReference.mjs';

const plugin = (id, name, families = []) => ({ id, name, description: '', families, dir: id });

test('the projected manifest carries every family, so only the used ones are rendered', () => {
  // `contributes` is projected with all ~38 families present and mostly empty.
  // Rendering the keys directly would claim every plugin contributes everything.
  const families = contributedFamilies({
    actions: [{ id: 'a' }],
    agents: [],
    settings: { page: {} },
    tools: [],
    ui: null,
  });
  assert.deepEqual(families, ['actions', 'settings']);
});

test('a plugin in no category fails the build rather than vanishing from the page', () => {
  assert.throws(
    () => categorize([plugin('happier.agent.claude', 'Claude'), plugin('happier.newthing', 'New')]),
    /bundled plugins in no category: happier\.newthing/,
  );
});

test('a standalone plugin that stopped shipping fails too', () => {
  assert.throws(
    () => categorize([plugin('happier.agent.claude', 'Claude')]),
    /STANDALONE names plugins that are no longer bundled/,
  );
});

test('a manifest with nothing bundling it is not a shipped plugin', () => {
  assert.throws(
    () => renderBundledPluginMarkdown({
      plugins: [plugin('happier.agent.claude', 'Claude'), plugin('happier.agent.ghost', 'Ghost')],
      bundledIds: new Set(['happier.agent.claude']),
    }),
    /have a manifest but are not in the bundled registry: happier\.agent\.ghost/,
  );
});

test('a bundled id with no built manifest is a broken build, not a shorter page', () => {
  assert.throws(
    () => renderBundledPluginMarkdown({
      plugins: [plugin('happier.agent.claude', 'Claude')],
      bundledIds: new Set(['happier.agent.claude', 'happier.agent.missing']),
    }),
    /names plugins with no projected manifest: happier\.agent\.missing/,
  );
});

test('the admitted bundled registry contains projected plugin ids', async () => {
  const registry = await readBundledPluginRegistry();
  const ids = new Set(registry.BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map((entry) => entry.pluginId));
  assert.ok(ids.has('happier.channels'));
});

test('the bundled Machine family is categorized without dropping its plugins', async () => {
  const registry = await readBundledPluginRegistry();
  const plugins = registry.BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map((entry) => entry.pluginId)
    .map((id) => plugin(id, id));
  const machines = plugins.filter((entry) => entry.id.startsWith('happier.machine.'));
  assert.ok(machines.length > 0);
  const section = categorize(plugins).find((entry) => entry.prefix === 'happier.machine.');
  assert.deepEqual(section?.plugins, machines);
});

// CodeBuddy is admitted by ordinary source publication without a packed plugin.json.
test('source-admitted CodeBuddy is included without requiring a packed plugin artifact', async () => {
  const markdown = await renderBundledPluginReferenceMarkdown();
  assert.ok(markdown.includes('`happier.agent.codebuddy`'));
});
