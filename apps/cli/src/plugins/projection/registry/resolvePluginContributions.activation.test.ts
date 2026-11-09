import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createMergedContributionRegistry, createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from './fullProjection';
import { loadCurrentBundledPluginLocatorResult } from './builtIn/locators';

describe('resolved plugin activation projection', () => {
  it('resolves external qualified Connected Account access against bundled manifests without projecting bundled contributions', () => {
    const plugin: LoadedPlugin = {
      pluginId: 'com.acme.claude-consumer',
      pluginRootPath: '/plugins/com.acme.claude-consumer',
      manifestPath: '/plugins/com.acme.claude-consumer/.happier-plugin/plugin.json',
      daemonEntryPath: '/plugins/com.acme.claude-consumer/dist/plugin.js',
      devDaemonEntryPath: null,
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/com.acme.claude-consumer',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2,
        id: 'com.acme.claude-consumer',
        version: '1.0.0',
        displayName: 'Claude consumer',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/plugin.js' },
        hostAccess: {
          required: [{
            id: 'claude-account',
            capability: 'connectedAccounts',
            reason: 'Use the selected Claude account',
            scope: {
              serviceRefs: [{
                pluginId: 'happier.agent.claude',
                localId: 'claude-subscription',
              }],
              operations: ['use'],
            },
          }],
          optional: [],
        },
        contributes: {
          actions: [{
            id: 'run',
            title: 'Run',
            scopes: ['global'],
            surfaces: ['ui'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
            hostAccess: ['claude-account'],
          }],
        },
      }),
    };

    const projected = projectLoadedPluginContributes({
      loadResult: {
        loadedPlugins: [plugin],
        diagnosticsByPluginId: {},
      },
      provenance: 'external',
    });

    expect(projected.actions).toMatchObject([{
      pluginId: plugin.pluginId,
      definition: {
        id: 'run',
        hostAccess: ['claude-account'],
      },
    }]);
    expect(projected.connectedAccountDescriptors ?? []).toEqual([]);
    expect(projected.introspectionContributions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'happier.agent.claude',
      }),
    ]));
    expect(projected.activationTargets).toEqual([
      expect.objectContaining({
        pluginId: plugin.pluginId,
        provenance: 'external',
      }),
    ]);
    expect(projected.activationTargets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'happier.agent.claude',
      }),
    ]));
  });

  it('keeps unknown bundled Connected Account references fail-closed for external projection', () => {
    const plugin: LoadedPlugin = {
      pluginId: 'com.acme.unknown-consumer',
      pluginRootPath: '/plugins/com.acme.unknown-consumer',
      manifestPath: '/plugins/com.acme.unknown-consumer/.happier-plugin/plugin.json',
      daemonEntryPath: null,
      devDaemonEntryPath: null,
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/com.acme.unknown-consumer',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2,
        id: 'com.acme.unknown-consumer',
        version: '1.0.0',
        displayName: 'Unknown consumer',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: {},
        hostAccess: {
          required: [{
            id: 'unknown-account',
            capability: 'connectedAccounts',
            reason: 'Use an unknown bundled account',
            scope: {
              serviceRefs: [{
                pluginId: 'happier.agent.claude',
                localId: 'missing',
              }],
              operations: ['use'],
            },
          }],
          optional: [],
        },
        contributes: {},
      }),
    };

    const excluded = projectLoadedPluginContributes({
      loadResult: {
        loadedPlugins: [plugin],
        diagnosticsByPluginId: {},
      },
      provenance: 'external',
    });
    expect(excluded.activationTargets).toEqual([]);
    expect(excluded.pluginDiagnosticsByPluginId?.[plugin.pluginId]).toMatchObject([{
      code: 'plugin_manifest_invalid', details: { reason: 'plugin_manifest_dangling_reference' },
    }]);
  });

  it('projects a development replacement of bundled Channels as one effective identity', () => {
    const bundled = loadCurrentBundledPluginLocatorResult().loadedPlugins.find(plugin => plugin.pluginId === 'happier.channels');
    if (!bundled) throw new Error('Bundled Channels fixture is required');
    const candidate: LoadedPlugin = {
      ...bundled,
      pluginRootPath: '/plugins/development-channels',
      manifestPath: '/plugins/development-channels/.happier-plugin/plugin.json',
      daemonEntryPath: null,
      devDaemonEntryPath: '/plugins/development-channels/src/index.ts',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/development-channels',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        devWatch: true,
      },
      manifest: normalizePluginManifestV2({
        ...bundled.manifest,
        version: '2.0.0',
        contributes: {
          ...bundled.manifest.contributes,
          actions: [...bundled.manifest.contributes.actions, {
            id: 'development-check', title: 'Development check', scopes: ['global'],
            surfaces: ['ui'], placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe',
          }],
        },
      }),
    };

    const projected = projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [candidate], diagnosticsByPluginId: {} },
      provenance: 'external',
    });
    const registry = createMergedContributionRegistry(projected, getResolvedContributionRegistry());
    expect(registry.activationTargets.filter(target => target.pluginId === candidate.pluginId)).toEqual([expect.objectContaining({
      pluginId: 'happier.channels', manifestPath: candidate.manifestPath,
    })]);
    const actions = registry.actions.filter(action => action.pluginId === candidate.pluginId);
    expect(actions).toHaveLength(candidate.manifest.contributes.actions.length);
    expect(actions.every(action => action.pluginVersion === '2.0.0')).toBe(true);
    expect(registry.actions.find(action => action.definition.id === 'development-check')).toMatchObject({
      pluginId: candidate.pluginId, pluginRootPath: candidate.pluginRootPath,
      source: { kind: 'path' },
    });
  });

  it('rejects two external sources claiming the same bundled identity', () => {
    const bundled = loadCurrentBundledPluginLocatorResult().loadedPlugins.find(plugin => plugin.pluginId === 'happier.channels');
    if (!bundled) throw new Error('Bundled Channels fixture is required');
    const candidates = ['/plugins/channels-one', '/plugins/channels-two'].map((pluginRootPath): LoadedPlugin => ({
      ...bundled, pluginRootPath,
      sourceSpec: { kind: 'path', locator: pluginRootPath, trustPolicy: 'local_trusted', installPolicy: 'link' },
    }));
    expect(() => projectLoadedPluginContributes({
      loadResult: { loadedPlugins: candidates, diagnosticsByPluginId: {} },
      provenance: 'external',
    })).toThrow(/Duplicate plugin identity 'happier\.channels'/u);
  });

  it('carries an executable Voice declaration through the canonical resolved registry', () => {
    const plugin: LoadedPlugin = {
      pluginId: 'com.acme.voice', pluginRootPath: '/plugins/com.acme.voice',
      manifestPath: '/plugins/com.acme.voice/.happier-plugin/plugin.json',
      daemonEntryPath: null, devDaemonEntryPath: null,
      generatedUiArtifactsManifest: {
        version: 2,
        entries: [{
          artifactId: 'voice-runtime', tier: 'reactNative',
          entry: 'react-native/voice-runtime/entry.cjs.bundle', files: [{
            relativePath: 'react-native/voice-runtime/entry.cjs.bundle',
            digest: `sha256:${'2'.repeat(64)}`,
            byteSize: 1,
          }],
          digest: `sha256:${'1'.repeat(64)}`,
          builtWith: { bundler: 'esbuild', version: '0.25.0' },
          executable: { exports: ['activate'] },
          hostUiApiRange: '^1.0.0',
        }],
      },
      sourceSpec: { kind: 'path', locator: '/plugins/com.acme.voice', trustPolicy: 'local_trusted', installPolicy: 'link' },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2, id: 'com.acme.voice', version: '1.0.0', displayName: 'Voice',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, entrypoints: {},
        contributes: { voiceProviders: [{
          id: 'conversation', title: 'Conversation', kind: 'conversation',
          roles: ['realtime_conversation', 'turn_control'], platforms: ['web'],
          capabilities: { turn: { cancelResponse: true, bargeIn: true } },
          client: { artifactId: 'voice-runtime', exportName: 'activate' },
        }] },
      }),
    };
    const projected = projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} }, provenance: 'external',
    });

    expect(createResolvedContributionRegistry(projected).voiceProviders).toMatchObject([{
      pluginId: 'com.acme.voice', pluginRootPath: '/plugins/com.acme.voice',
      identity: { pluginId: 'com.acme.voice', localId: 'conversation' },
      generatedUiArtifactsManifest: { entries: [{ artifactId: 'voice-runtime' }] },
      definition: { client: { exportName: 'activate' } },
    }]);
  });

  it('retains a development-only plugin activation target without fabricating a daemon entry', () => {
    const plugin: LoadedPlugin = {
      pluginId: 'com.acme.development-only',
      pluginRootPath: '/plugins/com.acme.development-only',
      manifestPath: '/plugins/com.acme.development-only/.happier-plugin/plugin.json',
      daemonEntryPath: null,
      devDaemonEntryPath: '/plugins/com.acme.development-only/src/daemon.ts',
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/com.acme.development-only',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2,
        id: 'com.acme.development-only',
        version: '1.0.0',
        displayName: 'Development only',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
        entrypoints: { development: './src/daemon.ts' },
        contributes: {},
      }),
    };

    const projected = projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} },
      provenance: 'external',
    });

    expect(projected.activationTargets).toEqual([
      expect.objectContaining({
        pluginId: plugin.pluginId,
        daemonEntryPath: null,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
      }),
    ]);
    expect(createResolvedContributionRegistry(projected).activationTargets).toEqual([
      expect.objectContaining({
        pluginId: plugin.pluginId,
        daemonEntryPath: null,
        devDaemonEntryPath: plugin.devDaemonEntryPath,
      }),
    ]);
  });
});
