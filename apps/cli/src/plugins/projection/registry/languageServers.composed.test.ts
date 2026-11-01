import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { createLanguageServerDefinitions } from '@/lsp/languageServerDefinitions';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createMergedContributionRegistry, createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';

describe('declarative language-server registry', () => {
  it('reads installed external declarations inertly, retains every supplier and retires a disabled plugin', async () => {
    const pluginId = 'com.acme.language';
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-language-server-declarations-'));
    onTestFinished(() => rm(pluginRoot, { recursive: true, force: true }));
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await mkdir(join(pluginRoot, '.happier-plugin'));
    const definition = { id: 'example', title: 'Example', languageIds: { example: 'example-lsp' },
      executable: { kind: 'systemTool', id: 'example-server' }, args: ['--stdio'],
      settings: { example: { checks: true } } };
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Example',
      runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' }, contributes: {
        languageServers: [definition], systemTools: [{ id: 'example-server', title: 'Example server', executableNames: ['example-server'] }],
      } }));
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'throw new Error("Language declarations must not activate plugin code");\n');
    const state = PluginStateFileV1Schema.parse({ t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: {
      [pluginId]: {
        source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
        compatibility: { status: 'compatible', diagnostics: [] },
        install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null }, state: { enabled: true },
      },
    } });
    const loaded = await loadPluginsFromState(state);
    expect(loaded.diagnosticsByPluginId[pluginId]).toEqual([]);
    const inputs = projectLoadedPluginContributes({ loadResult: loaded, provenance: 'external' });
    const registry = createResolvedContributionRegistry({ ...inputs,
      occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
    expect(registry.languageServers).toMatchObject([{ pluginId, provenance: 'external', source: { kind: 'path' },
      identity: { pluginId, localId: 'example' }, manifestPath, definition }]);
    const definitions = createLanguageServerDefinitions({ readCurrentContributionRegistry: () => registry });
    expect(definitions.findDefinitionsForDocument({ languageId: 'example', path: 'src/x.example' })).toMatchObject([
      { id: `${pluginId}/example`, pluginId, title: 'Example', executable: definition.executable, args: ['--stdio'] },
    ]);
    const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
    expect(projection.familiesById.languageServers?.entriesById[`${pluginId}/example`]?.definition).toEqual(definition);
    expect(PluginProjectionV2Schema.safeParse({ ...projection, familiesById: { ...projection.familiesById,
      languageServers: { family: 'languageServers', entriesById: { wrong: {
        ...projection.familiesById.languageServers?.entriesById[`${pluginId}/example`], id: 'wrong',
      } } },
    } }).success).toBe(false);
    const external = registry.languageServers?.[0];
    expect(external).toBeDefined();
    if (!external) return;
    const bundled = { ...external, provenance: 'first_party' as const, source: { kind: 'bundled' as const },
      pluginId: 'happier.language.example', identity: { pluginId: 'happier.language.example', localId: 'example' } };
    const merged = createMergedContributionRegistry(inputs, { languageServers: [bundled] });
    expect(merged.languageServers?.map(entry => entry.identity)).toEqual([
      { pluginId, localId: 'example' }, bundled.identity,
    ]);
    const installed = state.plugins[pluginId];
    if (!installed) throw new Error('Expected installed fixture');
    const disabled = await loadPluginsFromState({ ...state, plugins: { [pluginId]: { ...installed, state: { enabled: false } } } });
    expect(createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: disabled, provenance: 'external' })).languageServers).toEqual([]);
  });
});
