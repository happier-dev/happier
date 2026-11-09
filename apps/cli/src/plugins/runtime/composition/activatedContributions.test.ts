import { expect, it } from 'vitest';

import { resolvePluginCommandProjection } from '@/cli/pluginCommandProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { activatePluginRuntimeRegistry } from '../lifecycle/manager';
import { mergeActivatedContributes } from './activatedContributions';

it('preserves Action CLI aliases when composing an actual empty activation result', async () => {
  const pluginId = 'acme.activation-actions';
  const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({
    id: pluginId,
    contributes: { actions: [{
      id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli', 'agent'],
      dangerLevel: 'safe', execution: { target: 'daemon' },
      cli: { path: ['notes', 'read'], aliases: [['memo', 'read']] },
      tool: { name: 'read_note' },
    }] },
  }));
  const base = createResolvedContributionRegistry(projectLoadedPluginContributes({
    loadResult: { loadedPlugins: [{
      pluginId, manifest, pluginRootPath: '/plugins/' + pluginId,
      manifestPath: '/plugins/' + pluginId + '/plugin.json',
      daemonEntryPath: null, devDaemonEntryPath: null,
      sourceSpec: { kind: 'path', locator: '/plugins/' + pluginId, trustPolicy: 'local_trusted', installPolicy: 'link' },
    }], diagnosticsByPluginId: {} },
    provenance: 'external',
  }));
  const activated = await activatePluginRuntimeRegistry({
    contributes: createResolvedContributionRegistry({}), generation: 1,
  });
  try {
    const merged = mergeActivatedContributes(base, activated, new Map(), () => true);
    expect(resolvePluginCommandProjection({ registry: merged, reservedRoots: new Set() }).commands)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ qualifiedActionId: `${pluginId}/read`, path: ['notes', 'read'], status: 'available' }),
        expect.objectContaining({ qualifiedActionId: `${pluginId}/read`, path: ['memo', 'read'], status: 'available' }),
      ]));
    expect(merged.actionsById?.get(`${pluginId}/read`)?.admittedTarget?.declaration.tool)
      .toEqual({ name: 'read_note' });
  } finally {
    await activated.dispose();
  }
});
