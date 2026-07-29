import { describe, expect, it } from 'vitest';

import type { PluginStateRecord } from '@/plugins/store/state';

import { resolveInstalledPluginUpdate } from './resolveInstalledUpdate';

function npmRecord(updatePolicy: 'automatic' | 'manual' | 'pinned'): PluginStateRecord {
  return {
    source: {
      kind: 'package',
      locator: '@acme/example',
      trustPolicy: 'prompt',
      installPolicy: 'managed_install',
      resolvedPath: '/tmp/installed',
      manifestPath: '/tmp/installed/.happier-plugin/plugin.json',
    },
    compatibility: { status: 'compatible', diagnostics: [] },
    install: {
      mode: 'managed_install',
      manifestVersion: '1.0.0',
      updatePolicy,
      trust: {
        pluginId: 'acme.example',
        state: 'trusted',
        approvedAtMs: 1,
        distribution: {
          kind: 'npm',
          packageName: '@acme/example',
          registryOrigin: 'https://registry.example.test',
          registryProfileId: 'registry_private',
        },
      },
    },
    state: { enabled: true },
  };
}

describe('resolveInstalledPluginUpdate', () => {
  it('preserves the daemon-owned npm channel and policy while leaving version resolution open', () => {
    expect(resolveInstalledPluginUpdate('acme.example', npmRecord('automatic'))).toEqual({
      kind: 'npm',
      request: {
        kind: 'installNpm',
        packageName: '@acme/example',
        registryOrigin: 'https://registry.example.test',
        registryProfileId: 'registry_private',
      },
      updatePolicy: 'automatic',
    });
  });

  it('rejects pinned channels instead of reinstalling or advancing them', () => {
    expect(() => resolveInstalledPluginUpdate('acme.example', npmRecord('pinned')))
      .toThrowError(expect.objectContaining({ code: 'plugin_update_pinned' }));
  });

  it('uses the trusted canonical local path for development updates', () => {
    const record: PluginStateRecord = {
      ...npmRecord('manual'),
      source: {
        kind: 'path',
        locator: '/stale/consumer/path',
        trustPolicy: 'prompt',
        installPolicy: 'link',
        resolvedPath: '/tmp/source',
        manifestPath: '/tmp/source/.happier-plugin/plugin.json',
        devWatch: true,
      },
      install: {
        mode: 'link',
        manifestVersion: '1.0.0',
        updatePolicy: 'manual',
        trust: {
          pluginId: 'acme.example',
          state: 'trusted',
          approvedAtMs: 1,
          distribution: {
            kind: 'localPath',
            canonicalPath: '/canonical/source',
          },
        },
      },
    };

    expect(resolveInstalledPluginUpdate('acme.example', record)).toEqual({
      kind: 'path',
      request: {
        kind: 'installPath',
        locator: '/canonical/source',
        development: true,
      },
    });
  });
});
