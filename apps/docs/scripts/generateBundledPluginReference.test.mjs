import assert from 'node:assert/strict';
import test from 'node:test';

import {
  categorize,
  contributedFamilies,
  readBundledPluginIds,
  renderBundledPluginMarkdown,
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

test('the registry is parsed from the compiled bundled list', () => {
  const ids = readBundledPluginIds('{ "pluginId": "happier.agent.claude" }, { "pluginId": "happier.triage" }');
  assert.deepEqual([...ids].sort(), ['happier.agent.claude', 'happier.triage']);
  assert.throws(() => readBundledPluginIds('{}'), /parsed to zero ids/);
});
