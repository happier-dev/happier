import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './resolvePluginContributions';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';

describe('plugin input type projection', () => {
  it('keeps identical local ids qualified and withdraws a retired occurrence', () => {
    const ids = ['com.acme.one', 'com.acme.two'];
    const loadedPlugins = ids.map((pluginId): LoadedPlugin => ({
      pluginId, pluginRootPath: `/plugins/${pluginId}`, manifestPath: `/plugins/${pluginId}/plugin.json`,
      daemonEntryPath: null, devDaemonEntryPath: null,
      sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
      manifest: normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Input types',
        runtime: { apiVersion: 1 }, contributes: { inputTypes: [{ id: 'repository', title: 'Repository',
          semantic: 'com.acme.repository', valueSchema: { type: 'string' } }] },
      }),
    }));
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party' });
    const registry = createResolvedContributionRegistry({ ...inputs,
      occurrenceIdsByPluginId: Object.fromEntries(ids.map((id) => [id, createPluginRuntimeOccurrenceId(id)])),
    });
    const origin = { serverIdentityId: 'srv_inputs', materializationRef: {
      machineId: 'input-machine', materializationId: 'input-materialization', pluginId: ids[0]!,
    } };
    const projection = buildPluginProjectionV2({ registry, generation: 1,
      pluginExecutionOriginsByPluginId: { [ids[0]!]: origin } });
    expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
    expect(Object.keys(projection.familiesById.inputTypes?.entriesById ?? {})).toEqual(ids.map((id) => `${id}/repository`));
    const family = projection.familiesById.inputTypes;
    if (!family) throw new Error('Expected input type family');
    const entry = family.entriesById[`${ids[0]}/repository`];
    expect(entry?.occurrenceId).toBe(registry.occurrenceIdsByPluginId?.[ids[0]!]);
    expect(entry).toMatchObject(origin);
    expect(PluginProjectionV2Schema.safeParse({ ...projection, familiesById: { ...projection.familiesById,
      inputTypes: { ...family, entriesById: { invalid: { ...entry, id: 'invalid id/repository', pluginId: 'invalid id' } } },
    } }).success).toBe(false);
    expect(buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }),
      generation: 2 }).familiesById.inputTypes?.entriesById).toEqual({});
  });
});
