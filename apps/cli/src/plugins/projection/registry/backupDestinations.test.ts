import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';

it('carries an external destination through admitted manifest, serving projection and occurrence retirement', () => {
    const pluginId = 'com.acme.backups';
    const configSchema = { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'], additionalProperties: false };
    const definition = { id: 'disk', title: 'Local recovery', configSchema,
        credentialRoles: ['repositoryPassword'], resticTransport: 'local', locality: 'local',
        actions: { test: { pluginId, localId: 'test' }, open: { pluginId, localId: 'open' } } };
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Backups',
        runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' }, contributes: { backupDestinations: [definition],
            actions: ['test', 'open'].map(id => ({ id, title: id, execution: { target: 'daemon' }, surfaces: ['plugin'],
                scopes: ['global'], dangerLevel: id === 'test' ? 'writesRemote' : 'safe', inputSchema: configSchema, resultSchema: configSchema })) } });
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/acme', manifestPath: '/plugins/acme/plugin.json',
        daemonEntryPath: '/plugins/acme/daemon.mjs', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
    const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
    expect(projection.familiesById).toMatchObject({ backupDestinations: { family: 'backupDestinations', entriesById: {
        [`${pluginId}/disk`]: { pluginId, pluginVersion: '1.0.0', occurrenceId, definition },
    } } });
    expect(buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }), generation: 2 }).familiesById)
        .toMatchObject({ backupDestinations: { entriesById: {} } });
});
