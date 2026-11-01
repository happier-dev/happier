import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  categorize,
  contributedFamilies,
  readBundledPluginRegistry,
  renderBundledPluginMarkdown,
  renderBundledPluginReferenceMarkdown,
} from './generateBundledPluginReference.mjs';

const plugin = (id, name, families = []) => ({ id, name, description: '', families, dir: id });

async function bundledPlugins() {
  const registry = await readBundledPluginRegistry();
  return registry.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map((entry) => {
    const manifest = JSON.parse(fs.readFileSync(new URL(`../../cli/${entry.manifestRelativePath}`, import.meta.url), 'utf8'));
    return plugin(entry.pluginId, entry.pluginId, contributedFamilies(manifest.contributes));
  });
}

test('secret sources are categorized by their declared contribution family regardless of plugin id', async () => {
  const plugins = await bundledPlugins();
  const custom = plugin('example.vault', 'Vault', ['secretSources']);
  plugins.push(custom);
  const members = plugins.filter((entry) => entry.families.includes('secretSources'));
  assert.ok(members.length > 1);
  const sections = categorize(plugins);
  const section = sections.find((entry) => entry.plugins.includes(custom));
  assert.deepEqual(section?.plugins, members);
});

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

test('the bundled Machine and language families are categorized without dropping their plugins', async () => {
  const plugins = await bundledPlugins();
  for (const prefix of ['happier.machine.', 'happier.language.']) {
    const members = plugins.filter((entry) => entry.id.startsWith(prefix));
    assert.ok(members.length > 0);
    const section = categorize(plugins).find((entry) => entry.prefix === prefix);
    assert.deepEqual(section?.plugins, members);
  }
});

// CodeBuddy is admitted by ordinary source publication without a packed plugin.json.
test('source-admitted CodeBuddy and Email are included without requiring packed plugin artifacts', async () => {
  const markdown = await renderBundledPluginReferenceMarkdown();
  assert.ok(markdown.includes('`happier.agent.codebuddy`'));
  assert.ok(markdown.includes('`happier.channel.email`'));
});

test('the normal docs renderer reads source projections without caller-provided TypeScript preloads', () => {
  const rendererUrl = new URL('./generateBundledPluginReference.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { renderBundledPluginReferenceMarkdown } = await import(${JSON.stringify(rendererUrl)});
    const markdown = await renderBundledPluginReferenceMarkdown();
    console.log(markdown.includes('happier.channel.email'));
  `], { encoding: 'utf8' });
  assert.equal(output.trim(), 'true');
});

test('missing or mismatched admitted projections fail instead of skipping or publishing another plugin', async (t) => {
  const emailPath = fileURLToPath(new URL('../../cli/assets/bundled-plugin-manifests/channel-email.json', import.meta.url));
  const discordBytes = fs.readFileSync(new URL('../../cli/assets/bundled-plugin-manifests/channel-discord.json', import.meta.url));
  const readFileSync = fs.readFileSync;
  for (const [bytes, expected] of [
    [null, /Cannot read bundled manifest projection for 'happier\.channel\.email'/],
    [discordBytes, /Bundled manifest id 'happier\.channel\.discord' does not match locator 'happier\.channel\.email'/],
  ]) {
    // Filesystem bytes are the external boundary; ingress and rendering stay real.
    t.mock.method(fs, 'readFileSync', (path, ...args) => {
      if (path !== emailPath) return readFileSync(path, ...args);
      if (bytes !== null) return bytes;
      throw Object.assign(new Error('Missing projection'), { code: 'ENOENT' });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(renderBundledPluginReferenceMarkdown(), (error) => {
        assert.match(error.message, expected);
        assert.notEqual(error.code, 'ENOENT');
        return true;
      });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});
