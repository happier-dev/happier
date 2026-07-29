import { describe, expect, it } from 'vitest';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { projectNormalizedRegistryIntrospection } from './normalizedRegistry';

function loaded(): LoadedPlugin {
  const pluginId = 'acme.introspection';
  return {
    pluginId,
    pluginRootPath: `/plugins/${pluginId}`,
    manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: `/plugins/${pluginId}/dist/plugin.js`,
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      devWatch: true,
    },
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: pluginId,
      version: '2.0.0',
      displayName: 'Introspection',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      contributes: {
        actions: [{
          id: 'run',
          title: 'Run',
          scopes: ['session'],
          surfaces: ['cli'],
          placement: 'primary',
          dangerLevel: 'safe',
        }],
        commands: [{ id: 'run-command', title: 'Run', path: ['run'], action: 'run' }],
      },
    }),
  };
}

describe('normalized contribution introspection adapter', () => {
  it('projects every semantic entry exactly once with catalog-owned facts', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded()] });
    const projection = projectNormalizedRegistryIntrospection({
      registry,
      generation: 7,
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 50,
      diagnosticsByPluginId: {},
    });

    expect(projection.contributions.map((entry) => entry.contribution.qualifiedId)).toEqual([
      'acme.introspection/actions/run',
      'acme.introspection/commands/run-command',
    ]);
    expect(projection.contributions[0]).toMatchObject({
      stability: 'stable',
      registration: { requirement: 'required', state: 'unbound' },
      consumer: 'action-dispatch',
    });
    expect(projection.contributions[1]).toMatchObject({
      registration: { requirement: 'notRequired', state: 'notRequired' },
      consumer: 'cli-commands',
    });
    expect(projection.contributions.every((entry) => entry.progression.merged === true)).toBe(true);
  });

  it('maps compatibility diagnostics to host-owned records without collapsing repeated facts', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loaded()] });
    const projection = projectNormalizedRegistryIntrospection({
      registry,
      generation: 7,
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 50,
      diagnosticsByPluginId: {
        'acme.introspection': [
          { code: 'plugin_manifest_semantic_invalid', message: 'Invalid declaration' },
          { code: 'plugin_manifest_semantic_invalid', message: 'Invalid declaration' },
        ],
      },
    });

    expect(projection.diagnostics).toHaveLength(2);
    expect(projection.diagnostics[0]?.id).not.toBe(projection.diagnostics[1]?.id);
    expect(projection.diagnostics.every((entry) => entry.stage === 'normalization')).toBe(true);
  });
});
