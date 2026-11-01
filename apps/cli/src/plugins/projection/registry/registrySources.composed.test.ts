import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { PluginMachineMaterializationExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { createPluginRegistrySourceDescriptorV1, listRegistrySourcesV1, RegistrySourceDescriptorV1Schema } from '@happier-dev/protocol/registries';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { normalizePluginUiProjection } from '../../../../../ui/sources/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '../../../../../ui/sources/sync/domains/plugins/ui/projectionUnion';
import { projectPluginRegistrySources } from '../../../../../ui/sources/registries/pluginRegistrySources';
import { readBundledPluginManifest } from './builtIn/locators';

describe('declarative registry sources', () => {
  it('composes authored sources into strict daemon and Account projections, keeps all suppliers, and retires removed sources', async () => {
    const pluginId = 'com.acme.skills';
    const authored = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, registrySources: {
      team: { title: 'Team skills', format: 'git', kinds: ['skill'], url: 'https://github.com/acme/skills' },
    } });
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-registry-source-declarations-'));
    onTestFinished(() => rm(pluginRoot, { recursive: true, force: true }));
    const manifestRelativePath = '.happier-plugin/plugin.json';
    const manifestPath = join(pluginRoot, manifestRelativePath);
    await mkdir(join(pluginRoot, '.happier-plugin'));
    await writeFile(manifestPath, JSON.stringify(authored.manifest));
    // Declaration discovery must never evaluate the plugin's executable leaf.
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'throw new Error("Registry source discovery must be inert");\n');
    const manifest = normalizePluginManifestV2(readBundledPluginManifest({ manifestRelativePath }, pluginRoot));
    const state = PluginStateFileV1Schema.parse({ t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: {
      [pluginId]: {
        source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
        compatibility: { status: 'compatible', diagnostics: [] },
        install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null },
        state: { enabled: true },
      },
    } });
    const loadResult = await loadPluginsFromState(state);
    expect(loadResult.diagnosticsByPluginId[pluginId]).toEqual([]);
    expect(loadResult.loadedPlugins[0]?.manifest).toEqual(manifest);
    const inputs = projectLoadedPluginContributes({ loadResult, provenance: 'external' });
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
    const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
    expect(projection.familiesById.registrySources?.entriesById[`${pluginId}/team`]?.definition).toMatchObject({ id: 'team', format: 'git' });
    expect(projection.installedPackagesById[pluginId]?.enabled).toBe(true);
    const origin = (machineId: string) => PluginMachineMaterializationExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_registry_sources',
      materializationRef: { machineId, materializationId: `${machineId}:install`, pluginId } });
    const member = (machineId: string) => ({ machineId, serverId: 'home', phase: 'current' as const, interactionEnabled: true,
      projection: normalizePluginUiProjection(PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1,
        pluginExecutionOriginsByPluginId: { [pluginId]: origin(machineId) } }))) });
    const supplierA = member('supplier-a');
    expect(supplierA.projection.registrySourcesById[`${pluginId}/team`]).toBeDefined();
    const union = unionPluginUiProjections([supplierA, { ...member('supplier-b'), phase: 'retainedOffline' as const, interactionEnabled: false }],
      new Map([[pluginId, origin('supplier-a')]]));
    expect(union.pluginUiProjection?.registrySourcesById[`${pluginId}/team`]).toBeDefined();
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: projectPluginRegistrySources(union.pluginUiProjection) });
    const source = sources.find(source => source.id === `${pluginId}/team`);
    expect(RegistrySourceDescriptorV1Schema.parse(source)).toMatchObject({ removable: false,
      origin: { kind: 'plugin', pluginId, localId: 'team', suppliers: ['supplier-a', 'supplier-b'] } });
    expect(registry.registrySources?.map(entry => createPluginRegistrySourceDescriptorV1({
      pluginId: entry.pluginId, definition: entry.definition, suppliers: [],
    }))).toEqual([{ ...source, origin: { kind: 'plugin', pluginId, localId: 'team', suppliers: [] } }]);
    expect(PluginProjectionV2Schema.safeParse({ ...projection, familiesById: { ...projection.familiesById,
      registrySources: { family: 'registrySources', entriesById: { wrong: { ...projection.familiesById.registrySources?.entriesById[`${pluginId}/team`], id: 'wrong' } } },
    } }).success).toBe(false);
    const installedRecord = state.plugins[pluginId];
    if (!installedRecord) throw new Error('Fixture plugin must be installed');
    const disabled = projectLoadedPluginContributes({ loadResult: await loadPluginsFromState({ ...state, plugins: {
      [pluginId]: { ...installedRecord, state: { enabled: false } },
    } }), provenance: 'external' });
    expect(createResolvedContributionRegistry(disabled).registrySources).toEqual([]);
    const uninstalled = projectLoadedPluginContributes({ loadResult: await loadPluginsFromState({ ...state, plugins: {} }), provenance: 'external' });
    const removed = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry: createResolvedContributionRegistry(uninstalled), generation: 2 }));
    expect(projectPluginRegistrySources(unionPluginUiProjections([{ ...member('supplier-a'), projection: normalizePluginUiProjection(removed) }]).pluginUiProjection)).toEqual([]);
  });
});
