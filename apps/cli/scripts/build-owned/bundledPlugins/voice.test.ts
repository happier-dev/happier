import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { renderBundledVoiceRuntimeEntriesTs } from './voice';

it('loads the actual generated Voice declarations through the strict consumer and default registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-voice-declarations-'));
  try {
    const uiRoot = fileURLToPath(new URL('../../../../ui/sources/', import.meta.url));
    const entry = join(root, 'entry.ts');
    writeFileSync(entry, `
      import assert from 'node:assert/strict';
      import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
      import { createVoiceProviderSettingsCatalog } from '@happier-dev/protocol/voice/settings/providerSettings';
      import { BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS as declarations } from ${JSON.stringify(join(uiRoot, 'voice/registry/generatedBundledVoiceEntries.ts'))};
      import { createDefaultVoiceProviderRegistry } from ${JSON.stringify(join(uiRoot, 'voice/registry/defaultRegistry.ts'))};
      assert.ok(declarations.length > 0);
      const registry = createDefaultVoiceProviderRegistry();
      for (const { declaration, providerId } of declarations) {
        // Runtime owners use these declarations as admitted, so the generated form must be the admitted form.
        assert.deepEqual(JSON.parse(JSON.stringify(VoiceProviderContributionSchema.parse(declaration))), JSON.parse(JSON.stringify(declaration)));
        assert.equal(registry.get(providerId)?.providerId, providerId);
      }
      assert.ok(registry.list().length >= declarations.length);
      // Voice settings parsing keeps an untouched provider's default without re-admitting it.
      for (const owner of createVoiceProviderSettingsCatalog({ bundledContributions: declarations }).list()) {
        assert.deepEqual(owner.parseStoredConfig(owner.defaultConfig), owner.defaultConfig);
      }
    `);
    const output = join(root, 'consumer.cjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs',
      absWorkingDir: fileURLToPath(new URL('../../../../../', import.meta.url)),
      alias: { '@': uiRoot }, conditions: ['happier-source'], nodePaths: [join(process.cwd(), 'node_modules')] });
    const loaded = spawnSync(process.execPath, [output], { encoding: 'utf8' });
    expect(loaded.status, loaded.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  { host: 'web', projection: 'web', format: 'esm' },
  { host: 'Hermes iOS', projection: 'ios', format: 'cjs' },
  { host: 'Hermes Android', projection: 'android', format: 'cjs' },
  { host: 'desktop (web projection)', projection: 'web', format: 'cjs' },
] as const)('evaluates only the selected provider in the compiled $host graph ($format)', async ({ projection, format }) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-voice-demand-'));
  try {
    const sources = (['openai', 'elevenlabs', 'xai'] as const).map(id => {
      const parsed = ingestPluginManifestV2({
        schemaVersion: 2, id: `test.voice.${id}`, version: '0.0.0', displayName: id,
        runtime: { apiVersion: 1 }, contributes: { voiceProviders: [{
          id, title: id, kind: 'conversation', roles: ['realtime_conversation'],
          platforms: ['web', 'ios', 'android'],
          capabilities: { turn: { cancelResponse: false, bargeIn: false } },
          client: { artifactId: 'voice-runtime', exportName: 'activate' },
        }] },
      });
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
      return {
        pluginPackageId: id, packageName: `@happier-dev/plugins-${id}`, packageVersion: '0.0.0',
        pluginId: parsed.manifest.id, manifest: parsed.manifest,
        hasConversationProvider: true, conversationClient: { artifactId: 'voice-runtime', exportName: 'activate' },
        conversationPlatforms: ['web', 'ios', 'android'] as const, presentations: [],
      };
    });
    const metadata = join(root, 'metadata.ts');
    writeFileSync(metadata, sources.map(source => `export const ${source.pluginPackageId.toUpperCase()}_BUNDLED_VOICE_MANIFEST = ${JSON.stringify(source.manifest)};`).join('\n'));
    // Provider modules are the executable package boundary. Their side effects
    // count evaluation independently from activation and generated source shape.
    const providers = Object.fromEntries(sources.map(source => {
      const path = join(root, `${source.pluginPackageId}.ts`);
      writeFileSync(path, `globalThis.evaluated.push(${JSON.stringify(source.pluginPackageId)}); export function activate() {}`);
      return [`${source.packageName}/happier-plugin-ui/voice-runtime`, path];
    }));
    const entry = join(root, 'entry.ts');
    writeFileSync(entry, renderBundledVoiceRuntimeEntriesTs(sources, projection));
    const extension = format === 'esm' ? '.mjs' : '.cjs';
    await build({ entryPoints: [entry], outdir: join(root, 'compiled'), bundle: true, splitting: format === 'esm',
      platform: 'browser', format, outExtension: { '.js': extension },
      alias: providers,
      plugins: [{ name: 'voice-fixture-inputs', setup(builder) {
        builder.onResolve({ filter: /^\.\/generatedBundledVoiceEntries$/ }, () => ({ path: metadata }));
        builder.onResolve({ filter: /^\.\/bundledConversationRuntimeEntries$/ }, () => ({
          path: fileURLToPath(new URL('../../../../ui/sources/voice/registry/bundledConversationRuntimeEntries.ts', import.meta.url)),
        }));
      } }],
      conditions: ['happier-source'],
    });
    const loaded = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      globalThis.evaluated = [];
      const graph = await import(${JSON.stringify(pathToFileURL(join(root, `compiled/entry${extension}`)).href)});
      const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES: entries } = ${format === 'cjs' ? 'graph.default' : 'graph'};
      assert.deepEqual(globalThis.evaluated, [], 'cold/unselected providers must not evaluate');
      const selected = entries.find(entry => entry.providerId === 'test.voice.openai/openai');
      const activate = await selected.loadActivate();
      assert.equal(typeof activate, 'function', 'compiled module preserves the named activation export');
      assert.deepEqual(globalThis.evaluated, ['openai'], 'exactly the selected provider evaluates');
      await selected.loadActivate();
      assert.deepEqual(globalThis.evaluated, ['openai'], 'module evaluation is shared by the runtime');
    `], { encoding: 'utf8' });
    expect(loaded.status, loaded.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
