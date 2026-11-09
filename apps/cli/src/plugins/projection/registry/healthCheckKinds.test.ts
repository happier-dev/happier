import { expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { HealthCheckResultV1ProtocolSchema, SavedHealthCheckSelectorV1ProtocolSchema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';

it('projects a qualified external health kind and withdraws it with its supplying occurrence', () => {
    const pluginId = 'com.example.health';
    const definition = { id: 'endpoint', title: 'External endpoint',
        configSchema: { type: 'object', properties: {}, additionalProperties: false }, action: 'observe-health' };
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External health',
        entrypoints: { daemon: './daemon.mjs' }, contributes: { healthCheckKinds: [definition], actions: [{
            id: 'observe-health', title: 'Observe health', scopes: ['machine'], surfaces: ['plugin'],
            execution: { target: 'daemon' }, dangerLevel: 'safe', readOnly: true,
            inputSchema: SavedHealthCheckSelectorV1ProtocolSchema.jsonSchema,
            resultSchema: HealthCheckResultV1ProtocolSchema.jsonSchema,
        }] } });
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/example', manifestPath: '/plugins/example/plugin.json',
        daemonEntryPath: '/plugins/example/daemon.mjs', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
    const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
    expect(projection.familiesById.healthCheckKinds?.entriesById[`${pluginId}/endpoint`]).toMatchObject({
        pluginId, pluginVersion: '1.0.0', occurrenceId, definition,
    });
    expect(buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }), generation: 2 }).familiesById)
        .toMatchObject({ healthCheckKinds: { entriesById: {} } });
});
