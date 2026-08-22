import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPluginStateStore,
  PluginStateFileV1Schema,
  resolvePredecessorPluginStorePaths,
  writeCommittedLocalPathPluginFixture,
} from './state.testkit';
import {
  createDefaultPluginAccessScopeRegistry,
} from './install/accessScopeRegistry';
import {
  createNpmPluginDistributionIdentity,
  createPluginTrustRecord,
} from './install/trustIdentity';
import { resolvePluginStorePaths } from './paths';
import { readPluginRegistryCommitRecord } from './registry/commitRecord';
import { readInstallationStateRevision } from './registry/generationStore';

describe('pluginStateStore', () => {
  it('reads an empty default state when the plugin registry file does not exist yet', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });

    await expect(store.read()).resolves.toEqual({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {},
    });
  });

  it('writes the canonical plugin state file under the plugins/plugins state directory', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePredecessorPluginStorePaths({ happyHomeDir });

    await store.write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.ohmypi': {
          source: {
            kind: 'path',
            locator: '/plugins/acme-ohmypi',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: '/plugins/acme-ohmypi',
            manifestPath: '/plugins/acme-ohmypi/.happier-plugin/plugin.json',
          },
          compatibility: {
            status: 'compatible',
            diagnostics: [],
          },
          install: {
            mode: 'link',
            manifestVersion: '1.0.0',
            installedPath: null,
          },
          state: {
            enabled: true,
          },
        },
      },
    });

    await expect(access(paths.stateFilePath)).resolves.toBeUndefined();
    const parsed = JSON.parse(await readFile(paths.stateFilePath, 'utf8'));
    expect(parsed.plugins['acme.ohmypi'].state.enabled).toBe(true);
    await expect(store.read()).resolves.toMatchObject({
      plugins: {
        'acme.ohmypi': {
          source: {
            manifestPath: '/plugins/acme-ohmypi/.happier-plugin/plugin.json',
          },
          state: {
            enabled: true,
          },
        },
      },
    });
  });

  it('rejects retired raw source and install manifest digests from persisted state', () => {
    const plugin = {
      source: {
        kind: 'path' as const,
        locator: '/plugins/acme-retired-digest',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
        resolvedPath: '/plugins/acme-retired-digest',
        manifestPath: '/plugins/acme-retired-digest/.happier-plugin/plugin.json',
      },
      compatibility: { status: 'compatible' as const, diagnostics: [] },
      install: { mode: 'link' as const, manifestVersion: '1.0.0', installedPath: null },
      state: { enabled: true },
    };

    const rawSourceDigest = PluginStateFileV1Schema.safeParse({
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: {
        'acme.retired-digest': {
          ...plugin,
          source: { ...plugin.source, resolvedDigest: 'sha256:retired-source' },
        },
      },
    });
    expect(rawSourceDigest.success).toBe(false);
    const rawInstallState = {
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: {
        'acme.retired-digest': {
          ...plugin,
          install: { ...plugin.install, manifestDigest: 'sha256:retired-manifest' },
        },
      },
    };
    const rawInstallDigest = PluginStateFileV1Schema.safeParse(rawInstallState);
    expect(rawInstallDigest.success).toBe(false);
  });

  it('rejects future plugin state schema versions fail-closed', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePredecessorPluginStorePaths({ happyHomeDir });

    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(
      paths.stateFilePath,
      JSON.stringify({
        t: 'happier_plugin_state_v1',
        schemaVersion: 2,
        plugins: {},
      }),
      'utf8',
    );

    await expect(store.read()).rejects.toThrow(/Invalid plugin state file/);
  });

  it('rejects partial legacy plugin records fail-closed', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePredecessorPluginStorePaths({ happyHomeDir });

    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(
      paths.stateFilePath,
      JSON.stringify({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.legacy': {
            state: {
              enabled: true,
            },
          },
        },
      }),
      'utf8',
    );

    await expect(store.read()).rejects.toThrow(/Invalid plugin state file/);
  });

  it('persists strictly validated trust, update policy, and structured optional access in the canonical installed-state record', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const distribution = createNpmPluginDistributionIdentity({
      registryOrigin: 'https://registry.example.test',
      packageName: '@acme/plugin',
    });
    const trust = createPluginTrustRecord({ pluginId: 'acme.plugin', distribution, approvedAtMs: 20 });
    const access = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: 'acme.plugin', accessId: 'account', capability: 'connectedAccounts',
      scope: {
        serviceRefs: ['primary'],
        operations: ['use'],
        materializationKinds: ['files', 'environment'],
      },
      selectedAtMs: 21,
    });

    await store.write({
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: {
        'acme.plugin': {
          source: {
            kind: 'package', locator: '@acme/plugin', trustPolicy: 'prompt', installPolicy: 'managed_install',
            resolvedPath: '/plugins/acme-plugin', manifestPath: '/plugins/acme-plugin/.happier-plugin/plugin.json',
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: {
            mode: 'managed_install', manifestVersion: '1.0.0', installedPath: '/plugins/acme-plugin',
            trust, updatePolicy: 'automatic', optionalAccess: [access],
          },
          state: { enabled: true },
        },
      },
    });

    await expect(store.read()).resolves.toMatchObject({
      plugins: {
        'acme.plugin': {
          install: {
            trust: { pluginId: 'acme.plugin', distribution },
            updatePolicy: 'automatic',
            optionalAccess: [{
              pluginId: 'acme.plugin',
              accessId: 'account',
              capability: 'connectedAccounts',
              normalizedScope: {
                serviceRefs: ['primary'],
                operations: ['use'],
                materializationKinds: ['environment', 'files'],
              },
            }],
          },
        },
      },
    });
  });

  it('rejects trust/access identity substitution and unknown persisted access capabilities', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePredecessorPluginStorePaths({ happyHomeDir });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.stateFilePath, JSON.stringify({
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: {
        'acme.plugin': {
          source: { kind: 'path', locator: '/plugins/acme', trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: '/plugins/acme', manifestPath: '/plugins/acme/plugin.json' },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: {
            mode: 'link', manifestVersion: '1.0.0',
            trust: { pluginId: 'acme.substitute', distribution: { kind: 'localPath', canonicalPath: '/plugins/acme' }, state: 'trusted', approvedAtMs: 1 },
            updatePolicy: 'manual',
            optionalAccess: [{ pluginId: 'acme.plugin', accessId: 'future', capability: 'future.capability', normalizedScope: {}, scopeDigest: 'sha256-YWJj', selectedAtMs: 2 }],
          },
          state: { enabled: true },
        },
      },
    }), 'utf8');

    await expect(store.read()).rejects.toThrow(/Invalid plugin state file/);
  });

  it('rejects non-canonical plugin record keys instead of normalizing persisted authority', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const paths = resolvePredecessorPluginStorePaths({ happyHomeDir });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.stateFilePath, JSON.stringify({
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: {
        ' acme.plugin ': {
          source: { kind: 'path', locator: '/plugins/acme', trustPolicy: 'prompt', installPolicy: 'link', resolvedPath: '/plugins/acme', manifestPath: '/plugins/acme/plugin.json' },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0' },
          state: { enabled: true },
        },
      },
    }), 'utf8');

    await expect(store.read()).rejects.toThrow(/Invalid plugin state file/);
  });

  it('rejects duplicate persisted optional access identities', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });
    const selection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: 'acme.plugin', accessId: 'env', capability: 'environment',
      scope: { keys: ['TOKEN'] }, selectedAtMs: 1,
    });
    const record = {
      source: { kind: 'path' as const, locator: '/plugins/acme', trustPolicy: 'prompt' as const, installPolicy: 'link' as const, resolvedPath: '/plugins/acme', manifestPath: '/plugins/acme/plugin.json' },
      compatibility: { status: 'compatible' as const, diagnostics: [] },
      install: { mode: 'link' as const, manifestVersion: '1.0.0', optionalAccess: [selection, selection] },
      state: { enabled: true },
    };

    await expect(store.write({
      t: 'happier_plugin_state_v1', schemaVersion: 1,
      plugins: { 'acme.plugin': record },
    })).rejects.toThrow(/duplicate.*access/i);
  });

  it('serializes concurrent transactional updates so plugin state changes are not lost', async () => {
    const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-plugin-state-')));
    const store = createPluginStateStore({ happyHomeDir });

    await Promise.all([
      store.update(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ...state,
          plugins: {
            ...state.plugins,
            'acme.alpha': {
              source: {
                kind: 'path',
                locator: '/plugins/acme-alpha',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
                resolvedPath: '/plugins/acme-alpha',
                manifestPath: '/plugins/acme-alpha/.happier-plugin/plugin.json',
              },
              compatibility: {
                status: 'compatible',
                diagnostics: [],
              },
              install: {
                mode: 'link',
                manifestVersion: '1.0.0',
                installedPath: null,
              },
              state: {
                enabled: true,
              },
            },
          },
        };
      }),
      store.update(async (state) => ({
        ...state,
        plugins: {
          ...state.plugins,
          'acme.beta': {
            source: {
              kind: 'path',
              locator: '/plugins/acme-beta',
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: '/plugins/acme-beta',
              manifestPath: '/plugins/acme-beta/.happier-plugin/plugin.json',
            },
            compatibility: {
              status: 'compatible',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      })),
    ]);

    await expect(store.read()).resolves.toMatchObject({
      plugins: {
        'acme.alpha': expect.any(Object),
        'acme.beta': expect.any(Object),
      },
    });
  });
});

describe('writeCommittedLocalPathPluginFixture', () => {
  it('commits the current immutable generation without retired health state', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-committed-plugin-fixture-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-committed-plugin-fixture-root-'));
    const pluginId = 'acme.committed-fixture';
    try {
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Committed fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: {},
      }), 'utf8');
      await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}', 'utf8');

      const fixture = await writeCommittedLocalPathPluginFixture({
        happyHomeDir,
        pluginId,
        sourceRootPath: pluginRoot,
        plugin: {
          source: {
            kind: 'path',
            locator: pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null },
          state: { enabled: true },
        },
      });

      const paths = resolvePluginStorePaths({ happyHomeDir });
      const commit = await readPluginRegistryCommitRecord(paths);
      if (!commit) throw new Error('Expected committed plugin fixture');
      const generation = commit.pluginGenerations[pluginId];
      if (!generation) throw new Error('Expected committed plugin generation');
      const state = await readInstallationStateRevision({
        paths,
        reference: commit.installationState,
      });

      expect(generation.immutableGenerationId).toBe(fixture.immutableGenerationId);
      expect(state.plugins[pluginId]).toMatchObject({
        enabled: true,
      });
      expect(state).not.toHaveProperty('health');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});
