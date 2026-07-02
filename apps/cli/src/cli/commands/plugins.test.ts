import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as tar from 'tar';
import { describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createMarketplaceCatalogDocument, createMarketplaceCatalogEntry } from '@/plugins/testkit/marketplaceCatalog';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createPluginStateStore } from '@/plugins/store/state';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { handlePluginsCommand } from './plugins';

async function createRemoteMarketplaceServer(): Promise<Readonly<{
  catalogUrl: string;
  archiveUrl: string;
  close: () => Promise<void>;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), `happier-marketplace-source-${randomUUID()}-`));
  const archiveRoot = join(pluginSourceRoot, 'sample-plugin');
  await materializeSamplePluginFixture(archiveRoot);
  const archivePath = join(pluginSourceRoot, 'sample-plugin.tar.gz');
  await tar.c({
    gzip: true,
    file: archivePath,
    cwd: pluginSourceRoot,
    portable: true,
  }, ['sample-plugin']);
  const archiveBytes = await readFile(archivePath);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname === '/catalog.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(createMarketplaceCatalogDocument({
        sourceUrl: `${url.origin}/catalog.json`,
        title: 'Curated Marketplace',
        description: 'Curated plugin discovery feed',
        entries: [
          createMarketplaceCatalogEntry({
            pluginId: SAMPLE_PLUGIN_ID,
            title: 'Acme Sample',
            description: 'Sample plugin from the marketplace',
            sourceUrl: `${url.origin}/entries/acme.sample.json`,
            packageUrl: `${url.origin}/plugins/acme.sample.tar.gz`,
            categories: ['providers'],
          }),
        ],
      })));
      return;
    }

    if (url.pathname === '/plugins/acme.sample.tar.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(archiveBytes);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind marketplace test server');
  }

  return {
    catalogUrl: `http://127.0.0.1:${address.port}/catalog.json`,
    archiveUrl: `http://127.0.0.1:${address.port}/plugins/acme.sample.tar.gz`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    },
  } as const;
}

async function writeDisposableActivationPlugin(rootDir: string, disposeMarkerPath: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(rootDir, 'daemon.mjs'),
    [
      'export async function activate() {',
      '  return {',
      '    async dispose() {',
      '      const { appendFile } = await import("node:fs/promises");',
      `      await appendFile(${JSON.stringify(disposeMarkerPath)}, "disposed\\n", "utf8");`,
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.reload-disposable',
        version: '1.0.0',
        displayName: 'Acme Reload Disposable',
        description: 'Exercises reload lifecycle ownership',
        engines: {
          happier: '^0.2.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: ['reload'],
        },
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        capabilities: {
          permissions: [],
        },
        contributes: {},
      }),
      null,
      2,
    ),
    'utf8',
  );
}

describe('handlePluginsCommand', () => {
  it('renders the plugins help page', async () => {
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['help']);

      expect(output.text()).toContain('happier plugins');
      expect(output.text()).toContain('happier plugins list [--json]');
      expect(output.text()).toContain('happier plugins install <path|archive> [--dry-run] [--force] [--json]');
      expect(output.text()).toContain('happier plugins reload [pluginId] [--json]');
      expect(output.text()).toContain('happier plugins marketplace sources list [--json]');
      expect(output.text()).toContain('happier plugins marketplace list [<sourceRef>] [--json]');
      expect(output.text()).toContain('Package/npm/git install sources are not implemented yet.');
    } finally {
      output.restore();
    }
  });

  it('boots the curated marketplace source into the shared registry and uses it without an explicit source reference', async () => {
    const home = await createTempDir('happier-plugin-marketplace-curated-default-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '', HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: marketplace.catalogUrl });

    try {
      const sourcesOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'list', '--json']);

        const parsed = sourcesOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            sources: Array<{
              id: string;
              title: string;
              sourceUrl: string;
              enabled: boolean;
              origin: string;
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_list');
        expect(parsed.data?.sources).toHaveLength(1);
        expect(parsed.data?.sources[0]).toMatchObject({
          title: 'Happier curated marketplace',
          sourceUrl: marketplace.catalogUrl,
          enabled: true,
          origin: 'curated',
        });
        expect(parsed.data?.sources[0].id).toMatch(/^marketplace:[0-9a-f]{12}$/);
      } finally {
        sourcesOutput.restore();
      }

      const installOutput = captureConsoleJsonOutput();
      try {
        const publishInstalledManifestProjections = vi.fn(async () => undefined);
        await handlePluginsCommand(['marketplace', 'install', SAMPLE_PLUGIN_ID, '--json'], {
          publishInstalledManifestProjections,
        });

        const parsed = installOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            plugin: {
              pluginId: string;
              source: { kind: string; locator: string };
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_install');
        expect(parsed.data?.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data?.plugin.source).toMatchObject({
          kind: 'archive',
          locator: marketplace.archiveUrl,
        });
        expect(publishInstalledManifestProjections).toHaveBeenCalledWith({
          pluginIds: [SAMPLE_PLUGIN_ID],
        });
      } finally {
        installOutput.restore();
      }

      const disableOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'disable', marketplace.catalogUrl, '--json']);

        const parsed = disableOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            source: {
              id: string;
              sourceUrl: string;
              enabled: boolean;
              origin: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_disable');
        expect(parsed.data?.source).toMatchObject({
          sourceUrl: marketplace.catalogUrl,
          enabled: false,
          origin: 'curated',
        });
      } finally {
        disableOutput.restore();
      }

      const disabledRegistry = JSON.parse(await readFile(join(home, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json'), 'utf8')) as {
        sources: Array<{ enabled: boolean }>;
      };
      expect(disabledRegistry.sources[0]?.enabled).toBe(false);
    } finally {
      await marketplace.close();
      envScope.restore();
      await removeTempDir(home);
    }
  });

  it('persists marketplace sources and uses the registry when browsing without an explicit source reference', async () => {
    const home = await createTempDir('happier-plugin-marketplace-registry-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();
    envScope.patch({ HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: marketplace.catalogUrl });
    try {
      const addOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'add', marketplace.catalogUrl, '--title', 'Curated Marketplace', '--json']);

        const parsed = addOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            source: {
              id: string;
              title: string;
              sourceUrl: string;
              enabled: boolean;
              origin: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_add');
        expect(parsed.data?.source).toMatchObject({
          title: 'Curated Marketplace',
          sourceUrl: marketplace.catalogUrl,
          enabled: true,
          origin: 'curated',
        });
        expect(parsed.data?.source.id).toMatch(/^marketplace:[0-9a-f]{12}$/);
      } finally {
        addOutput.restore();
      }

      const registryPath = join(home, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json');
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { sources: ReadonlyArray<{ sourceUrl: string; title: string; enabled: boolean }> };
      expect(registry.sources).toHaveLength(1);
      expect(registry.sources[0]).toMatchObject({
        title: 'Curated Marketplace',
        sourceUrl: marketplace.catalogUrl,
        enabled: true,
      });

      const sourcesOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'sources', 'list', '--json']);

        const parsed = sourcesOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            sources: Array<{
              id: string;
              title: string;
              sourceUrl: string;
              enabled: boolean;
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_sources_list');
        expect(parsed.data?.sources).toHaveLength(1);
        expect(parsed.data?.sources[0]).toMatchObject({
          title: 'Curated Marketplace',
          sourceUrl: marketplace.catalogUrl,
          enabled: true,
        });
      } finally {
        sourcesOutput.restore();
      }

      const listOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'list', '--json']);

        const parsed = listOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            source: {
              sourceUrl: string;
              title: string;
            };
            catalog: {
              sourceUrl: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_list');
        expect(parsed.data?.source).toMatchObject({
          title: 'Curated Marketplace',
          sourceUrl: marketplace.catalogUrl,
        });
        expect(parsed.data?.catalog.sourceUrl).toBe(marketplace.catalogUrl);
      } finally {
        listOutput.restore();
      }
    } finally {
      await marketplace.close();
      await removeTempDir(home).catch(() => undefined);
    }
  });

  it('installs a local-path plugin and exposes it through the JSON envelope', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['install', sourceRoot, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            alreadyInstalled: boolean;
            plugin: {
              pluginId: string;
              title: string;
              contributions: {
                providers: readonly string[];
                backends: readonly string[];
                hooks: readonly string[];
              };
            };
          };
        }>();

        if (!parsed.ok) {
          throw new Error(output.logs.join('\n'));
        }
        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_install');
        expect(parsed.data?.alreadyInstalled).toBe(false);
        expect(parsed.data?.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data?.plugin.title).toBe('Acme Sample');
        expect(parsed.data?.plugin.contributions.providers).toEqual(['acme.sample.provider']);
        expect(parsed.data?.plugin.contributions.backends).toEqual(['acme.sample.backend']);
        expect(parsed.data?.plugin.contributions.hooks).toEqual(['backend.terminalRuntime.resolveTranscriptBinding']);
      } finally {
        output.restore();
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('reloads plugin runtime contributions without disposing the active registry', async () => {
    const home = await createTempDir('happier-plugin-reload-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-source-'));
    const disposeMarkerPath = join(home, 'reload-dispose.log');
    await writeDisposableActivationPlugin(sourceRoot, disposeMarkerPath);

    try {
      const installOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['install', sourceRoot, '--json']);
        const installResult = installOutput.json<{ ok: boolean }>();
        if (!installResult.ok) {
          throw new Error(installOutput.logs.join('\n'));
        }
        expect(installResult.ok).toBe(true);
      } finally {
        installOutput.restore();
      }

      const reloadOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['reload', 'acme.reload-disposable', '--json']);

        const parsed = reloadOutput.json<{
          ok: boolean;
          kind: string;
          data?: {
            registryStatus: string;
            affectedPluginIds: readonly string[];
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_reload');
        expect(parsed.data).toMatchObject({
          registryStatus: 'active',
          affectedPluginIds: ['acme.reload-disposable'],
        });
      } finally {
        reloadOutput.restore();
      }

      await expect(readFile(disposeMarkerPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('installs a direct archive URL through the same plugin installer path', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();

    try {
      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['install', `${marketplace.archiveUrl}?download=1`, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            alreadyInstalled: boolean;
            plugin: {
              pluginId: string;
              source: { kind: string; locator: string; trustPolicy: string; installPolicy: string };
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_install');
        expect(parsed.data?.alreadyInstalled).toBe(false);
        expect(parsed.data?.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data?.plugin.source).toMatchObject({
          kind: 'archive',
          locator: `${marketplace.archiveUrl}?download=1`,
          trustPolicy: 'prompt',
          installPolicy: 'managed_install',
        });
      } finally {
        output.restore();
      }

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(state.plugins[SAMPLE_PLUGIN_ID]).toMatchObject({
        source: {
          kind: 'archive',
          locator: `${marketplace.archiveUrl}?download=1`,
          trustPolicy: 'prompt',
          installPolicy: 'managed_install',
        },
        install: {
          mode: 'managed_install',
        },
      });
    } finally {
      await marketplace.close();
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('does not persist local-path plugin state when install runs in dry-run mode', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);

    try {
      const installOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['install', sourceRoot, '--dry-run', '--json']);

        const parsed = installOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data?: {
            alreadyInstalled: boolean;
            plugin: {
              pluginId: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_install');
        expect(parsed.data?.alreadyInstalled).toBe(false);
        expect(parsed.data?.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
      } finally {
        installOutput.restore();
      }

      const listOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['list', '--json']);

        const parsed = listOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            plugins: Array<{
              pluginId: string;
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_list');
        expect(parsed.data.plugins).toEqual([]);
      } finally {
        listOutput.restore();
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('lists installed plugins through the JSON envelope after install', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    const canonicalSourceRoot = await realpath(sourceRoot);

    try {
      await handlePluginsCommand(['install', sourceRoot, '--json']);

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['list', '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            plugins: Array<{
              pluginId: string;
              title: string;
              enabled: boolean;
              source: { kind: string; locator: string };
              contributions: { providers: readonly string[]; backends: readonly string[]; hooks: readonly string[] };
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_list');
        expect(parsed.data.plugins).toHaveLength(1);
        expect(parsed.data.plugins[0].pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data.plugins[0].title).toBe('Acme Sample');
        expect(parsed.data.plugins[0].enabled).toBe(true);
        expect(parsed.data.plugins[0].source.kind).toBe('path');
        expect(parsed.data.plugins[0].source.locator).toBe(canonicalSourceRoot);
        expect(parsed.data.plugins[0].contributions.providers).toEqual(['acme.sample.provider']);
        expect(parsed.data.plugins[0].contributions.backends).toEqual(['acme.sample.backend']);
        expect(parsed.data.plugins[0].contributions.hooks).toEqual(['backend.terminalRuntime.resolveTranscriptBinding']);
      } finally {
        output.restore();
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('shows an installed plugin through the JSON envelope after install', async () => {
    const home = await createTempDir('happier-plugin-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
    await materializeSamplePluginFixture(sourceRoot);
    const canonicalSourceRoot = await realpath(sourceRoot);

    try {
      await handlePluginsCommand(['install', sourceRoot, '--json']);

      const output = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['show', SAMPLE_PLUGIN_ID, '--json']);

        const parsed = output.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            plugin: {
              pluginId: string;
              title: string;
              enabled: boolean;
              source: { kind: string; locator: string };
              contributions: { providers: readonly string[]; backends: readonly string[]; hooks: readonly string[] };
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_show');
        expect(parsed.data.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data.plugin.title).toBe('Acme Sample');
        expect(parsed.data.plugin.enabled).toBe(true);
        expect(parsed.data.plugin.source.kind).toBe('path');
        expect(parsed.data.plugin.source.locator).toBe(canonicalSourceRoot);
        expect(parsed.data.plugin.contributions.providers).toEqual(['acme.sample.provider']);
        expect(parsed.data.plugin.contributions.backends).toEqual(['acme.sample.backend']);
        expect(parsed.data.plugin.contributions.hooks).toEqual(['backend.terminalRuntime.resolveTranscriptBinding']);
      } finally {
        output.restore();
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('browses and installs a remote marketplace plugin through the JSON envelopes', async () => {
    const home = await createTempDir('happier-plugin-marketplace-cli-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const marketplace = await createRemoteMarketplaceServer();

    try {
      const listOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'list', marketplace.catalogUrl, '--json']);

        const parsed = listOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            catalog: {
              title: string;
              sourceUrl: string;
            };
            plugins: Array<{
              pluginId: string;
              title: string;
              source: { kind: string; locator: string };
              installable: boolean;
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_list');
        expect(parsed.data.catalog.title).toBe('Curated Marketplace');
        expect(parsed.data.catalog.sourceUrl).toBe(marketplace.catalogUrl);
        expect(parsed.data.plugins).toHaveLength(1);
        expect(parsed.data.plugins[0]).toMatchObject({
          pluginId: SAMPLE_PLUGIN_ID,
          title: 'Acme Sample',
          source: {
            kind: 'archive',
            locator: marketplace.archiveUrl,
          },
          installable: true,
        });
      } finally {
        listOutput.restore();
      }

      const showOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'show', marketplace.catalogUrl, SAMPLE_PLUGIN_ID, '--json']);

        const parsed = showOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            plugin: {
              pluginId: string;
              title: string;
              source: { kind: string; locator: string };
              contributions: {
                providers: readonly string[];
                backends: readonly string[];
                hooks: readonly string[];
              };
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_show');
        expect(parsed.data.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data.plugin.source.locator).toBe(marketplace.archiveUrl);
        expect(parsed.data.plugin.contributions).toEqual({
          providers: [],
          backends: [],
          hooks: [],
        });
      } finally {
        showOutput.restore();
      }

      const installOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['marketplace', 'install', marketplace.catalogUrl, SAMPLE_PLUGIN_ID, '--json']);

        const parsed = installOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            alreadyInstalled: boolean;
            plugin: {
              pluginId: string;
              title: string;
            };
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_marketplace_install');
        expect(parsed.data.alreadyInstalled).toBe(false);
        expect(parsed.data.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data.plugin.title).toBe('Acme Sample');
      } finally {
        installOutput.restore();
      }

      const installedOutput = captureConsoleJsonOutput();
      try {
        await handlePluginsCommand(['list', '--json']);

        const parsed = installedOutput.json<{
          v: 1;
          ok: boolean;
          kind: string;
          data: {
            plugins: Array<{
              pluginId: string;
              source: { kind: string; locator: string };
              contributions: { providers: readonly string[]; backends: readonly string[]; hooks: readonly string[] };
            }>;
          };
        }>();

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_list');
        expect(parsed.data.plugins).toHaveLength(1);
        expect(parsed.data.plugins[0].pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data.plugins[0].source.kind).toBe('archive');
        expect(parsed.data.plugins[0].source.locator).toBe(marketplace.archiveUrl);
        expect(parsed.data.plugins[0].contributions.providers).toEqual(['acme.sample.provider']);
        expect(parsed.data.plugins[0].contributions.backends).toEqual(['acme.sample.backend']);
        expect(parsed.data.plugins[0].contributions.hooks).toEqual(['backend.terminalRuntime.resolveTranscriptBinding']);
      } finally {
        installedOutput.restore();
      }
    } finally {
      await marketplace.close();
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });
});
