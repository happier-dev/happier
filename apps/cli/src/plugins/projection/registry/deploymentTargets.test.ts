import { expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { DeploymentTargetPreparationBaseV1ProtocolSchema, DeploymentTargetRoleInputProtocolSchemasV1,
    DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';

it('indexes managed data resource backing Actions and mutations through the same target role owner', () => {
    const pluginId = 'com.example.data';
    const closed = { type: 'object', properties: {}, additionalProperties: false };
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Data target',
        entrypoints: { daemon: './daemon.mjs' }, contributes: {
            deploymentTargets: [{ id: 'data', role: 'data', targetKind: 'database', title: 'Data', icon: 'server-outline',
                targetSchema: closed, linkSchema: closed, dataV1: { projects: {
                    list: 'projects', listAction: 'list-projects', provision: 'provision',
                } } }],
            resources: [{ id: 'projects', source: 'dynamic', scope: 'surface', kind: 'config', contentType: 'application/json' }],
            actions: ['list-projects', 'provision'].map(id => ({ id, title: id, scopes: ['global'], surfaces: ['plugin'],
                execution: { target: 'daemon' }, inputSchema: DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema,
                resultSchema: closed, dangerLevel: id === 'list-projects' ? 'safe' : 'writesLocal', readOnly: id === 'list-projects' })),
        } });
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/data', manifestPath: '/plugins/data/plugin.json',
        daemonEntryPath: '/plugins/data/daemon.mjs', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
    expect(registry.actions.filter(action => action.pluginId === pluginId).map(action => ({
        id: action.identity?.localId, roles: action.admittedTarget?.deploymentTargetRoles,
    }))).toEqual([
        { id: 'list-projects', roles: [{ targetLocalId: 'data', targetKind: 'database', role: 'projects.list' }] },
        { id: 'provision', roles: [{ targetLocalId: 'data', targetKind: 'database', role: 'projects.provision' }] },
    ]);
});

it('projects an admitted external runtime target and withdraws it with its supplying occurrence', () => {
    const pluginId = 'com.example.deploy';
    const closed = { type: 'object', properties: {}, additionalProperties: false };
    const definition = { id: 'runtime', role: 'runtime', targetKind: 'example', title: 'Example runtime', icon: 'server-outline',
        targetSchema: closed, linkSchema: closed,
        actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' } };
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Example target',
        entrypoints: { daemon: './daemon.mjs' }, contributes: { deploymentTargets: [definition],
            actions: (['inspect', 'link', 'deploy', 'observe'] as const).map(id => ({ id, title: id, scopes: ['global'], surfaces: ['plugin'],
                execution: { target: 'daemon' }, inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[id].jsonSchema,
                resultSchema: id === 'deploy' || id === 'observe' ? DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema : closed,
                dangerLevel: id === 'inspect' || id === 'observe' ? 'safe' : 'writesLocal' })) } });
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/example', manifestPath: '/plugins/example/plugin.json',
        daemonEntryPath: '/plugins/example/daemon.mjs', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
    const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
    expect(projection.familiesById).toMatchObject({ deploymentTargets: { family: 'deploymentTargets', entriesById: {
        [`${pluginId}/runtime`]: { pluginId, pluginVersion: '1.0.0', occurrenceId, definition },
    } } });
    expect(buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }), generation: 2 }).familiesById)
        .toMatchObject({ deploymentTargets: { entriesById: {} } });
});
