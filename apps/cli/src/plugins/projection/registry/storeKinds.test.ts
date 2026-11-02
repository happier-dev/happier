import { expect, it } from 'vitest';
import { createExternalStoreKind } from '../../../../../../packages/plugin-sdk/examples/public-authoring/storeKinds';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';

it('projects a Store kind through the loaded registry and withdraws it with its supplying occurrence', () => {
    const pluginId = 'com.example.store';
    const authored = createExternalStoreKind({ read: async () => null, write: async () => {}, remove: async () => {} });
    const manifest = normalizePluginManifestV2({ ...authored.manifest, entrypoints: { daemon: './daemon.mjs' } });
    const definition = manifest.contributes.storeKinds[0];
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/example', manifestPath: '/plugins/example/plugin.json',
        daemonEntryPath: '/plugins/example/daemon.mjs', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
    const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
    expect(Reflect.get(projection.familiesById, 'storeKinds')?.entriesById[`${pluginId}/theme`]).toMatchObject({
        pluginId, pluginVersion: '1.0.0', occurrenceId, definition,
    });
    expect(buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }), generation: 2 }).familiesById)
        .toMatchObject({ storeKinds: { entriesById: {} } });
});
