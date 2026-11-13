import { expect, it } from 'vitest';
import { machineRoleCatalogFromPluginsV1, resolveActiveMachineRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';

it('carries admitted plugin machineRoles to the registry the daemon roles runtime reads', () => {
    const pluginId = 'com.acme.tests';
    const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Tests',
        runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' }, contributes: { machineRoles: [
            { id: 'runner', title: 'Test runner', description: 'Runs suites', requires: ['sessions'], defaultActive: true },
            { id: 'intake', title: 'Hooks', description: 'Hook intake', partOf: 'intake' },
        ] } });
    const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/acme', manifestPath: '/plugins/acme/plugin.json',
        daemonEntryPath: '/plugins/acme/daemon.mjs', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest };
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const registry = createResolvedContributionRegistry(inputs);
    const catalog = machineRoleCatalogFromPluginsV1((registry.machineRoles ?? []).map(entry => ({ pluginId: entry.pluginId, declaration: entry.definition })));
    expect(catalog.map(entry => entry.id).sort()).toEqual([`${pluginId}/intake`, `${pluginId}/runner`]);
    expect([...resolveActiveMachineRolesV1({ host: 'x' }, catalog)]).toEqual(expect.arrayContaining([`${pluginId}/runner`, `${pluginId}/intake`]));
    expect([...resolveActiveMachineRolesV1({ rolesV1: { active: ['broker'] } }, catalog)]).toEqual(['broker']);
});
