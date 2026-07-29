import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { resolveMergedContributionRegistry } from './createResolvedContributionRegistry';

describe('resolveMergedContributionRegistry bundled reference universe', () => {
  it('accepts an installed external HostAccess reference to bundled Claude without duplicating its projection or activation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-bundled-ref-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundled-ref-'));
    const pluginId = 'com.acme.claude-consumer';
    const manifestDir = join(pluginRoot, '.happier-plugin');
    const manifestPath = join(manifestDir, 'plugin.json');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(pluginRoot, 'daemon.js'),
      'export default async function activate() { return null; }\n',
      'utf8',
    );
    await writeFile(
      manifestPath,
      JSON.stringify(createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Claude consumer',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.js' },
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
      }), null, 2),
      'utf8',
    );

    const store = createPluginStateStore({ happyHomeDir });
    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        [pluginId]: {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath,
          },
          compatibility: {
            status: 'unknown',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            manifestDigest: null,
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    const registry = await resolveMergedContributionRegistry({ happyHomeDir });

    expect(registry.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId,
        provenance: 'external',
        definition: expect.objectContaining({
          id: 'run',
          hostAccess: ['claude-account'],
        }),
      }),
    ]));
    expect(
      (registry.connectedAccountDescriptors ?? []).filter(
        (descriptor) => (
          descriptor.pluginId === 'happier.agent.claude'
          && descriptor.definition.id === 'claude-subscription'
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        provenance: 'first_party',
        definition: expect.objectContaining({ id: 'claude-subscription' }),
      }),
    ]);
    expect(
      registry.activationTargets.filter(
        (target) => target.pluginId === 'happier.agent.claude',
      ),
    ).toEqual([
      expect.objectContaining({
        provenance: 'first_party',
        source: { kind: 'bundled' },
      }),
    ]);
    expect(
      registry.activationTargets.filter((target) => target.pluginId === pluginId),
    ).toEqual([
      expect.objectContaining({
        provenance: 'external',
        source: { kind: 'path' },
      }),
    ]);
  });
});
