import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from './resolvePluginContributions';

describe('resolved plugin activation projection', () => {
  it('resolves external qualified Connected Account access against bundled manifests without projecting bundled contributions', () => {
    const plugin: LoadedPlugin = {
      pluginId: 'com.acme.claude-consumer',
      pluginRootPath: '/plugins/com.acme.claude-consumer',
      manifestPath: '/plugins/com.acme.claude-consumer/.happier-plugin/plugin.json',
      manifestDigest: 'sha256:claude-consumer',
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
            placement: 'commandPalette',
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
      manifestDigest: 'sha256:unknown-consumer',
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

    expect(() => projectLoadedPluginContributes({
      loadResult: {
        loadedPlugins: [plugin],
        diagnosticsByPluginId: {},
      },
      provenance: 'external',
    })).toThrow(
      /references missing connectedAccountDescriptors contribution happier\.agent\.claude\/missing/u,
    );
  });

  it('rejects an external projection that collides with a bundled plugin identity', () => {
    const spoofed: LoadedPlugin = {
      pluginId: 'happier.agent.claude',
      pluginRootPath: '/plugins/spoofed-claude',
      manifestPath: '/plugins/spoofed-claude/.happier-plugin/plugin.json',
      manifestDigest: 'sha256:spoofed-claude',
      daemonEntryPath: null,
      devDaemonEntryPath: null,
      sourceSpec: {
        kind: 'path',
        locator: '/plugins/spoofed-claude',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2,
        id: 'happier.agent.claude',
        version: '999.0.0',
        displayName: 'Spoofed Claude',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: {},
        contributes: {},
      }),
    };

    expect(() => projectLoadedPluginContributes({
      loadResult: {
        loadedPlugins: [spoofed],
        diagnosticsByPluginId: {},
      },
      provenance: 'external',
    })).toThrow(/Duplicate plugin identity 'happier\.agent\.claude'/u);
  });

  it('carries an executable Voice declaration through the canonical resolved registry', () => {
    const plugin: LoadedPlugin = {
      pluginId: 'com.acme.voice', pluginRootPath: '/plugins/com.acme.voice',
      manifestPath: '/plugins/com.acme.voice/.happier-plugin/plugin.json', manifestDigest: 'sha256:voice',
      daemonEntryPath: null, devDaemonEntryPath: null,
      generatedUiArtifactsManifest: {
        version: 1,
        entries: [{
          contributionId: 'voice-runtime', tier: 'reactNative', platform: 'web',
          entry: 'react-native/voice-runtime/index.js', files: [{
            relativePath: 'react-native/voice-runtime/index.js',
            digest: `sha256:${'2'.repeat(64)}`,
            byteSize: 1,
          }],
          digest: `sha256:${'1'.repeat(64)}`,
          builtWith: { bundler: 'vite', version: '7.0.0' },
          hostUiApiVersion: '1.0.0', compat: { react: '19.2.0', reactNative: '0.83.4' },
        }],
      },
      sourceSpec: { kind: 'path', locator: '/plugins/com.acme.voice', trustPolicy: 'local_trusted', installPolicy: 'link' },
      manifest: normalizePluginManifestV2({
        schemaVersion: 2, id: 'com.acme.voice', version: '1.0.0', displayName: 'Voice',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, entrypoints: {},
        contributes: { voiceProviders: [{
          id: 'conversation', title: 'Conversation', kind: 'conversation',
          roles: ['realtime_conversation', 'turn_control'], platforms: ['web'],
          capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: true } },
          client: { artifactId: 'voice-runtime', modulePath: './voiceRuntime', exportName: 'activate' },
        }] },
      }),
    };
    const projected = projectLoadedPluginContributes({
      loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} }, provenance: 'external',
    });

    expect(createResolvedContributionRegistry(projected).voiceProviders).toMatchObject([{
      pluginId: 'com.acme.voice', pluginRootPath: '/plugins/com.acme.voice',
      identity: { pluginId: 'com.acme.voice', localId: 'conversation' },
      generatedUiArtifactsManifest: { entries: [{ contributionId: 'voice-runtime' }] },
      definition: { client: { exportName: 'activate' } },
    }]);
  });

  it('retains a development-only plugin activation target without fabricating a daemon entry', () => {
    const plugin: LoadedPlugin = {
      pluginId: 'com.acme.development-only',
      pluginRootPath: '/plugins/com.acme.development-only',
      manifestPath: '/plugins/com.acme.development-only/.happier-plugin/plugin.json',
      manifestDigest: 'sha256:development-only',
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
