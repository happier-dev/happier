import { expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/onepassword/src/manifest';

it('projects qualified CLI authentication declarations through the current Machine catalog and withdraws removed tools', () => {
    const pluginId = PLUGIN_MANIFEST.id;
    const root = `/plugins/${pluginId}`;
    const plugin: LoadedPlugin = {
        pluginId, pluginRootPath: root, manifestPath: `${root}/plugin.json`,
        daemonEntryPath: null, devDaemonEntryPath: null,
        sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
        manifest: normalizePluginManifestV2({ ...PLUGIN_MANIFEST, contributes: { systemTools: PLUGIN_MANIFEST.contributes.systemTools } }),
    };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} }, provenance: 'first_party' });
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
    const projection = buildPluginProjectionV2({ registry, generation: 1 });
    expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
    expect(projection.installedPackagesById[pluginId]).toBeDefined();
    expect(projection.familiesById.systemTools?.entriesById[`${pluginId}/op`]).toMatchObject({
        id: `${pluginId}/op`, pluginId, definition: PLUGIN_MANIFEST.contributes.systemTools[0],
    });
    const withdrawn = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} });
    expect(buildPluginProjectionV2({ registry: withdrawn, generation: 2 }).familiesById.systemTools?.entriesById).toEqual({});
});
