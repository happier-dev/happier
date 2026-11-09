import { expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';

it('projects admitted external recipes and same-shape setup presets through occurrence retirement', () => {
  const pluginId = 'com.example.machine-setup';
  const recipe = { id: 'fonts', revision: '1', title: 'Fonts', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }] };
  const preset = { id: 'browser-bot', revision: '1', title: 'Browser bot', description: 'Fonts for bot tools', setup: { items: [{ kind: 'softwareRecipe', selection: {
    ref: { pluginId, recipeId: 'fonts', revision: '1' }, inputs: {},
  } }] } };
  const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Setup', runtime: { apiVersion: 1 },
    contributes: { machineRecipes: [recipe], machineSetupPresets: [preset] } });
  const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/setup', manifestPath: '/plugins/setup/plugin.json', daemonEntryPath: null,
    devDaemonEntryPath: null, sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
  const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
  const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
  const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
  const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
  expect(projection.familiesById).toMatchObject({ machineRecipes: { entriesById: { [`${pluginId}/fonts`]: { pluginId, occurrenceId, definition: recipe } } },
    machineSetupPresets: { entriesById: { [`${pluginId}/browser-bot`]: { pluginId, occurrenceId, definition: preset } } } });
  expect(buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }), generation: 2 }).familiesById)
    .toMatchObject({ machineRecipes: { entriesById: {} }, machineSetupPresets: { entriesById: {} } });
});
