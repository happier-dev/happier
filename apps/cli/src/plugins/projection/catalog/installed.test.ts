import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import type { UserPluginChangeResult } from '@/plugins/daemon/changeClient';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';

import { installPluginFromLocator, readInstalledPluginCatalog, uninstallPluginFromCatalog } from './installed';

const changeClient = vi.hoisted(() => ({
  requestUserPluginChange: vi.fn(async (): Promise<UserPluginChangeResult> => ({
    kind: 'unavailable',
    code: 'unexpected_test_call',
  })),
}));

vi.mock('@/plugins/daemon/changeClient', () => changeClient);

async function materializeCatalogPluginFixture(rootDir: string, pluginId: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      displayName: `Plugin ${pluginId}`,
      description: `Catalog fixture for ${pluginId}`,
      entrypoints: {
        daemon: './daemon.mjs',
      },
    }), null, 2),
    'utf8',
  );
}

async function seedInstalledPlugin(params: Readonly<{
  locator: string;
  happyHomeDir: string;
  dev?: boolean;
  workspaceRoot?: string;
}>) {
  void params.workspaceRoot;
  const service = createDaemonPluginChangeService({
    prepare: createDaemonPathPluginChangePreparer({
      happyHomeDir: params.happyHomeDir,
      runtimeLifecycle: {
        prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
      },
      runManagedPluginPnpm: async () => ({
        ok: true,
        result: { exitCode: 0, signal: null, stdout: '', stderr: '' },
      }),
    }),
  });
  const begun = await service.requestPluginChange({
    kind: 'installPath',
    locator: params.locator,
    development: params.dev === true,
  });
  const result = begun.kind === 'reviewRequired'
    ? await service.decidePluginChange({
        pendingChangeId: begun.pendingChangeId,
        decision: 'installAndTrust',
        actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'catalog-test', occurredAtMs: 1 },
      })
    : begun;
  return { ok: result.kind === 'committed', result } as const;
}

describe('pluginCatalog', () => {
  it('routes uninstall through the daemon without deleting linked source files or registry state locally', async () => {
    const home = await createTempDir('happier-plugin-catalog-uninstall-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const firstSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-uninstall-source-a-'));
    const secondSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-uninstall-source-b-'));
    await materializeCatalogPluginFixture(firstSourceRoot, 'acme.remove-me');
    await materializeCatalogPluginFixture(secondSourceRoot, 'acme.keep-me');
    try {
      await seedInstalledPlugin({
        locator: firstSourceRoot,
        happyHomeDir: home,
      });
      await seedInstalledPlugin({
        locator: secondSourceRoot,
        happyHomeDir: home,
      });

      changeClient.requestUserPluginChange.mockResolvedValueOnce({
        kind: 'committed',
        pluginId: 'acme.remove-me',
        desiredGeneration: null,
        appliedGeneration: null,
        pendingSurfaces: [],
      });
      const result = await uninstallPluginFromCatalog({
        pluginId: 'acme.remove-me',
        happyHomeDir: home,
      });

      expect(result).toMatchObject({
        ok: true,
        pluginId: 'acme.remove-me',
        removedInstalledPath: expect.stringContaining('/generations/'),
        entry: {
          pluginId: 'acme.remove-me',
          source: {
            kind: 'path',
          },
        },
      });

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries.map((entry) => entry.pluginId)).toEqual(['acme.keep-me', 'acme.remove-me']);
      await expect(readFile(join(firstSourceRoot, '.happier-plugin', 'plugin.json'), 'utf8')).resolves.toContain('acme.remove-me');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('projects durable desired and process-local applied generation through the ordinary catalog read', async () => {
    const home = await createTempDir('happier-plugin-catalog-currentness-');
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-catalog-currentness-source-'));
    await materializeCatalogPluginFixture(sourceRoot, 'acme.currentness');
    try {
      const installed = await seedInstalledPlugin({
        locator: sourceRoot,
        happyHomeDir: home,
      });
      expect(installed.result).toMatchObject({
        kind: 'committed',
        desiredGeneration: expect.any(String),
        appliedGeneration: expect.any(String),
      });
      if (
        installed.result.kind !== 'committed'
        || installed.result.desiredGeneration === null
      ) {
        throw new Error('Expected committed installed generation');
      }

      const afterResponseLoss = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(afterResponseLoss).toContainEqual(expect.objectContaining({
        pluginId: 'acme.currentness',
        desiredGeneration: installed.result.desiredGeneration,
        appliedGeneration: null,
      }));

    } finally {
      await removeTempDir(home);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('rejects host-derived bundled plugin state as not uninstallable', async () => {
    const home = await createTempDir('happier-plugin-catalog-uninstall-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
    const store = createPluginStateStore({ happyHomeDir: home });
    const bundledRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundled-state-'));
    try {
      await materializeCatalogPluginFixture(bundledRoot, 'happier.agent.bundled');
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'happier.agent.bundled': {
            source: {
              kind: 'bundled',
              locator: '@happier-dev/plugins-bundled',
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: bundledRoot,
              manifestPath: join(bundledRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'compatible',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: 'bundled:@happier-dev/plugins-bundled@0.0.0',
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      const result = await uninstallPluginFromCatalog({
        pluginId: 'happier.agent.bundled',
        happyHomeDir: home,
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'plugin_source_kind_unsupported',
            message: expect.stringMatching(/bundled/i),
          },
        ],
      });
      expect((await store.read()).plugins['happier.agent.bundled']).toBeDefined();
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('does not convert a dev flag into executable trust without present-user evidence', async () => {
    const home = await createTempDir('happier-plugin-catalog-dev-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const workspaceRoot = await createTempDir('happier-plugin-dev-workspace-');
    const sourceRoot = await createTempDir('happier-plugin-dev-source-', workspaceRoot);
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeFile(join(sourceRoot, 'src', 'daemon.ts'), 'export function activate() {}\n', 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.dev-install',
        displayName: 'Acme Dev Install',
        description: 'Dev install source metadata',
        entrypoints: {
          daemon: './daemon.mjs',
          development: './src/daemon.ts',
        },
      }), null, 2),
      'utf8',
    );

    try {
      changeClient.requestUserPluginChange.mockResolvedValueOnce({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-dev-install',
        review: createPluginInstallationReviewFixture({
          pluginId: 'acme.dev-install',
          displayName: 'Acme Dev Install',
          source: { kind: 'path', locator: sourceRoot },
          updateChannel: { kind: 'path', locator: sourceRoot, development: true },
        }),
      });
      const installResult = await installPluginFromLocator({
        locator: sourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
        dev: true,
        workspaceRoot,
      });

      expect(installResult).toMatchObject({
        ok: false,
        change: { kind: 'reviewRequired' },
        diagnostics: [{ code: 'plugin_trust_approval_required' }],
      });
      expect(changeClient.requestUserPluginChange).toHaveBeenLastCalledWith({
        request: {
          kind: 'installPath',
          locator: sourceRoot,
          development: true,
        },
        approval: 'none',
      });

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(state.plugins['acme.dev-install']).toBeUndefined();
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('does not silently trust arbitrary local dev installs outside the workspace', async () => {
    const home = await createTempDir('happier-plugin-catalog-dev-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-workspace-');
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-outside-workspace-'));
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeFile(join(sourceRoot, 'src', 'daemon.ts'), 'export function activate() {}\n', 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.dev-outside-workspace',
        displayName: 'Acme Dev Outside Workspace',
        description: 'Dev install trust-policy source metadata',
        entrypoints: {
          daemon: './daemon.mjs',
          development: './src/daemon.ts',
        },
      }), null, 2),
      'utf8',
    );

    try {
      changeClient.requestUserPluginChange.mockResolvedValueOnce({
        kind: 'reviewRequired',
        pendingChangeId: 'pending-dev-outside',
        review: createPluginInstallationReviewFixture({
          pluginId: 'acme.dev-outside-workspace',
          displayName: 'Acme Dev Outside Workspace',
          source: { kind: 'path', locator: sourceRoot },
          updateChannel: { kind: 'path', locator: sourceRoot, development: true },
        }),
      });
      const installResult = await installPluginFromLocator({
        locator: sourceRoot,
        happyHomeDir: home,
        skipIfInstalled: true,
        dev: true,
        workspaceRoot,
      });

      expect(installResult).toMatchObject({
        ok: false,
        diagnostics: [
          expect.objectContaining({
            code: 'plugin_trust_approval_required',
          }),
        ],
      });

      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins['acme.dev-outside-workspace']).toBeUndefined();
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('reads a canonically installed local-path plugin as a catalog entry', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    const canonicalSourceRoot = await realpath(sourceRoot);

    try {
      const seeded = await seedInstalledPlugin({
        locator: sourceRoot,
        happyHomeDir: home,
      });
      expect(seeded.ok).toBe(true);
      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(entry.contributionIntrospection.contributions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contribution: expect.objectContaining({
              pluginId: SAMPLE_PLUGIN_ID,
              family: 'agents',
            }),
            progression: { declared: true, normalized: true, merged: false },
          }),
          expect.objectContaining({
            contribution: expect.objectContaining({
              pluginId: SAMPLE_PLUGIN_ID,
              family: 'hooks',
            }),
          }),
        ]),
      );

      expect(entries[0].pluginId).toBe(SAMPLE_PLUGIN_ID);
      expect(entries[0].title).toBe('Acme Sample');
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].source.kind).toBe('path');
      expect(entries[0].source.locator).toBe(canonicalSourceRoot);
      expect(entries[0].manifest?.id).toBe(SAMPLE_PLUGIN_ID);
      expect(entries[0].contributionIntrospection.contributions.length).toBeGreaterThan(0);
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('projects a development plugin from its source entry before the production bundle exists', async () => {
    const home = await createTempDir('happier-plugin-catalog-development-entry-');
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-catalog-development-source-'));
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'src', 'index.ts'), 'export function activate() {}\n', 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: 'acme.development-catalog',
        displayName: 'Development Catalog',
        entrypoints: {
          daemon: './dist/index.js',
          development: './src/index.ts',
        },
      }), null, 2),
      'utf8',
    );

    try {
      const seeded = await seedInstalledPlugin({
        locator: sourceRoot,
        happyHomeDir: home,
        dev: true,
      });
      expect(seeded.ok).toBe(true);

      const entry = (await readInstalledPluginCatalog({ happyHomeDir: home }))[0]!;
      expect(entry.pluginId).toBe('acme.development-catalog');
      expect(entry.source).toMatchObject({ kind: 'path', devWatch: true });
      expect(entry.diagnostics).not.toContainEqual(expect.objectContaining({
        code: 'plugin_source_missing',
      }));
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(home);
    }
  });

  it('fails closed when current linked manifest bytes no longer match the persisted digest', async () => {
    const home = await createTempDir('happier-plugin-catalog-digest-');
    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-digest-source-'));
    await materializeCatalogPluginFixture(sourceRoot, 'acme.digest-bound');
    try {
      const installed = await seedInstalledPlugin({
        locator: sourceRoot,
        happyHomeDir: home,
      });
      expect(installed.ok).toBe(true);
      if (!installed.ok) return;
      const manifestPath = (await readInstalledPluginCatalog({ happyHomeDir: home }))[0]!.manifestPath;
      const changed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      changed.description = 'tampered after persisted digest';
      await writeFile(manifestPath, JSON.stringify(changed, null, 2), 'utf8');

      const [entry] = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entry).toMatchObject({
        pluginId: 'acme.digest-bound',
        manifest: null,
        diagnostics: [
          expect.objectContaining({
            code: 'plugin_manifest_semantic_invalid',
            message: expect.stringMatching(/digest/i),
          }),
        ],
      });
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(home);
    }
  });

  it('surfaces a diagnostic when an enabled plugin declares a missing daemon entry file', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.missing-daemon',
        version: '1.0.0',
        displayName: 'Acme Missing Daemon',
        description: 'Plugin manifest declares a daemon entry that is missing on disk',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './missing-daemon.mjs' },
        contributes: {},
      }), null, 2),
      'utf8',
    );

    try {
      const installResult = await seedInstalledPlugin({
        locator: sourceRoot,
        happyHomeDir: home,
      });

      expect(installResult.ok).toBe(true);
      if (!installResult.ok) return;
      const installedEntry = (await readInstalledPluginCatalog({ happyHomeDir: home }))[0]!;
      expect(installedEntry.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_missing',
            message: expect.stringMatching(/daemon entry does not exist/i),
          }),
        ]),
      );
      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.pluginId).toBe('acme.missing-daemon');
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('surfaces a missing-install-path diagnostic for archive-backed entries without dropping the entry', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const store = createPluginStateStore({ happyHomeDir: home });

    try {
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.descriptor-only': {
            source: {
              kind: 'archive',
              locator: '/plugins/acme.descriptor-only.tar.gz',
              trustPolicy: 'local_trusted',
              installPolicy: 'managed_install',
              resolvedPath: '/plugins/acme.descriptor-only.tar.gz',
              manifestPath: '/plugins/acme.descriptor-only/.happier-plugin/plugin.json',
            },
            compatibility: {
              status: 'compatible',
              diagnostics: [],
            },
            install: {
              mode: 'managed_install',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: '/plugins/acme.descriptor-only',
            },
            state: {
              enabled: true,
            },
          },
        },
      });

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginId).toBe('acme.descriptor-only');
      expect(entries[0].title).toBe('acme.descriptor-only');
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].manifest).toBeNull();
      expect(entries[0].diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_missing',
          }),
        ]),
      );
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('surfaces an unsupported-source-kind diagnostic for non-managed installs that are not path-backed', async () => {
    const home = await createTempDir('happier-plugin-catalog-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const store = createPluginStateStore({ happyHomeDir: home });

    try {
      await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.unsupported-source-kind': {
            source: {
              kind: 'package',
              locator: '@acme/unsupported-plugin',
              trustPolicy: 'prompt',
              installPolicy: 'link',
              resolvedPath: '@acme/unsupported-plugin',
              manifestPath: '@acme/unsupported-plugin/.happier-plugin/plugin.json',
            },
            compatibility: {
              status: 'compatible',
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

      const entries = await readInstalledPluginCatalog({ happyHomeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0].pluginId).toBe('acme.unsupported-source-kind');
      expect(entries[0].manifest).toBeNull();
      expect(entries[0].diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'plugin_source_kind_unsupported',
            message: expect.stringMatching(/unsupported for non-managed installs/i),
          }),
        ]),
      );
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });
});
