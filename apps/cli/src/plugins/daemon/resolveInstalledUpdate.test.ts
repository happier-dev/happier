import { describe, expect, it } from 'vitest';

import type { PluginStateRecord } from '@/plugins/store/state';

import { resolveInstalledPluginUpdate } from './resolveInstalledUpdate';

function npmRecord(
  updatePolicy: 'automatic' | 'manual' | 'pinned',
  hasCuratedUpdateSource = false,
  manifestVersion = '1.0.0',
): PluginStateRecord {
  const record: PluginStateRecord = {
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
      manifestVersion,
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
  if (hasCuratedUpdateSource) {
    Object.assign(record.install, {
      curatedUpdateSource: {
        id: 'marketplace:curated',
        sourceUrl: 'https://marketplace.example.test/catalog.json',
        registryProfileId: 'registry_private',
      },
    });
  }
  return record;
}

describe('resolveInstalledPluginUpdate', () => {
  it('preserves the daemon-owned npm channel and policy while leaving version resolution open', () => {
    expect(resolveInstalledPluginUpdate('acme.example', npmRecord('automatic', true))).toEqual({
      kind: 'npm',
      request: {
        kind: 'installNpm',
        packageName: '@acme/example',
        selector: '>=1.0.0',
        registryOrigin: 'https://registry.example.test',
        registryProfileId: 'registry_private',
      },
      updatePolicy: 'automatic',
    });
  });

  it('keeps preview updates on the same prerelease line and above the installed version', () => {
    expect(resolveInstalledPluginUpdate(
      'acme.example',
      npmRecord('automatic', true, '2.0.0-beta.1'),
    )).toMatchObject({
      kind: 'npm',
      request: {
        selector: '>=2.0.0-beta.1 <2.0.0',
      },
    });
  });

  it('rejects pinned channels instead of reinstalling or advancing them', () => {
    expect(() => resolveInstalledPluginUpdate('acme.example', npmRecord('pinned')))
      .toThrowError(expect.objectContaining({ code: 'plugin_update_pinned' }));
  });

  it('fails closed when an automatic npm record has no reviewed curated-source binding', () => {
    expect(() => resolveInstalledPluginUpdate('acme.example', npmRecord('automatic')))
      .toThrowError(expect.objectContaining({ code: 'plugin_update_trust_unavailable' }));
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
