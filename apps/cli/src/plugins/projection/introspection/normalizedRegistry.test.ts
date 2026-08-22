import { describe, expect, it } from 'vitest';

import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { collectManifestContributionIntrospectionCandidates } from './manifest';
import {
  buildPluginContributionIntrospectionIdentity,
  buildPluginContributionIntrospectionQualifiedId,
  readPluginContributionIntrospectionIdentityValue,
} from './project';
import {
  collectNormalizedRegistryIntrospectionCandidates,
  projectNormalizedRegistryIntrospection,
} from './normalizedRegistry';

function loaded(): LoadedPlugin {
  const pluginId = 'acme.introspection';
  return {
    pluginId,
    pluginRootPath: `/plugins/${pluginId}`,
    manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
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
          execution: { target: 'daemon' },
          placementBindings: ['primary'],
          dangerLevel: 'safe',
        }],
        commands: [{ id: 'run-command', title: 'Run', path: ['run'], action: 'run' }],
      },
    }),
  };
}

function loadedWithEveryIdentityKind(): LoadedPlugin {
  const base = loaded();
  return {
    ...base,
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: base.pluginId,
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
          execution: { target: 'daemon' },
          placementBindings: ['primary'],
          dangerLevel: 'safe',
        }],
        commands: [{ id: 'run-command', title: 'Run', path: ['run'], action: 'run' }],
        ui: { translations: [{ locale: 'en-US', messages: { greeting: 'Hello' } }] },
        providers: [{
          v: 1,
          id: 'introspection-provider',
          name: 'Introspection provider',
          kind: 'aggregator',
          endpointTemplates: [{
            id: 'introspection-openai-responses',
            protocol: 'openai-responses',
            baseUrl: 'https://example.test/v1',
            capabilities: {
              streaming: 'supported', toolRoundTrips: 'supported',
              statefulResponses: 'unknown', reasoningControls: 'supported',
            },
          }],
          catalog: {
            source: 'static',
            manualModelPolicy: 'allowed',
            staticModels: [{
              id: 'introspection-model',
              name: 'Introspection model',
              capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' },
            }],
          },
        }],
      },
    }),
  };
}

function loadedWithComposerReference(): LoadedPlugin {
  const base = loaded();
  return {
    ...base,
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: base.pluginId,
      version: '2.0.0',
      displayName: 'Introspection',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      contributes: {
        composerReferences: [{
          id: 'issues',
          title: { key: 'composer.issues.title', fallback: 'Issue tracker' },
          description: { key: 'composer.issues.description', fallback: 'Search project issues' },
          icon: 'search',
          triggers: ['$'],
        }],
      },
    }),
  };
}

describe('normalized contribution introspection adapter', () => {
  it('carries a composer reference declaration into the lifecycle projection without a UI-owned registry', () => {
    const registry = buildPluginContributionRegistry({ loadedPlugins: [loadedWithComposerReference()] });
    const projection = projectNormalizedRegistryIntrospection({
      registry,
      generation: 7,
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 50,
      diagnosticsByPluginId: {},
    });

    expect(projection.contributions).toEqual([
      expect.objectContaining({
        contribution: {
          kind: 'localId',
          pluginId: 'acme.introspection',
          family: 'composerReferences',
          qualifiedId: 'acme.introspection/composerReferences/issues',
          localId: 'issues',
        },
        presentation: {
          kind: 'composerReference',
          title: { key: 'composer.issues.title', fallback: 'Issue tracker' },
          description: { key: 'composer.issues.description', fallback: 'Search project issues' },
          icon: 'search',
          triggers: ['$'],
        },
      }),
    ]);
  });

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
      registration: { requirement: 'required', state: 'unbound' },
      consumer: 'action-dispatch',
    });
    expect(projection.contributions[1]).toMatchObject({
      registration: { requirement: 'notRequired', state: 'notRequired' },
      consumer: 'cli-commands',
    });
    expect(projection.contributions.every((entry) => entry.progression.merged === true)).toBe(true);
  });

  it('presents identities through the catalog-owned identity kind, matching the manifest producer', () => {
    const plugin = loadedWithEveryIdentityKind();
    const registry = buildPluginContributionRegistry({ loadedPlugins: [plugin] });
    const registryCandidates = collectNormalizedRegistryIntrospectionCandidates(registry);
    const manifestIdentitiesByQualifiedId = new Map(
      collectManifestContributionIntrospectionCandidates({
        manifest: plugin.manifest,
        source: 'development',
      }).map((candidate) => [
        buildPluginContributionIntrospectionQualifiedId(candidate),
        candidate.identity,
      ]),
    );

    for (const candidate of registryCandidates) {
      const catalogEntry = PLUGIN_CONTRIBUTION_CATALOG_V2
        .find((entry) => entry.manifestKey === candidate.family);
      if (!catalogEntry) throw new Error(`Unmodelled contribution family '${candidate.family}'`);
      const qualifiedId = buildPluginContributionIntrospectionQualifiedId(candidate);
      expect(candidate.identity).toEqual(buildPluginContributionIntrospectionIdentity({
        identityKind: catalogEntry.identityKind,
        identityValue: readPluginContributionIntrospectionIdentityValue(candidate.identity),
      }));
      expect(manifestIdentitiesByQualifiedId.get(qualifiedId)).toEqual(candidate.identity);
    }

    expect(new Set(registryCandidates.map((candidate) => candidate.identity.kind)))
      .toEqual(new Set(['localId', 'locale', 'delegatedDomain']));
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
