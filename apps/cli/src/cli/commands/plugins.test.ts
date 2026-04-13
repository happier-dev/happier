import { createServer } from 'node:http';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/extensions/plugins/testkit/samplePluginFixture';

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
      res.end(JSON.stringify({
        t: 'happier_plugin_marketplace_catalog_v1',
        schemaVersion: 1,
        sourceUrl: `${url.origin}/catalog.json`,
        title: 'Curated Marketplace',
        description: 'Curated plugin discovery feed',
        entries: [
          {
            schemaVersion: 1,
            id: SAMPLE_PLUGIN_ID,
            version: '1.0.0',
            displayName: 'Acme Sample',
            description: 'Sample plugin from the marketplace',
            engines: {
              happier: '^0.2.0',
            },
            targets: {
              daemon: {
                entry: './daemon.mjs',
              },
            },
            contributions: {
              providers: [
                {
                  kindVersion: 1,
                  id: 'acme.sample.provider',
                  display: {
                    name: 'Acme Sample Provider',
                  },
                  ownedBackendIds: ['acme.sample.backend'],
                },
              ],
              backends: [
                {
                  kindVersion: 1,
                  id: 'acme.sample.backend',
                  providerId: 'acme.sample.provider',
                  runtimeKind: 'acp',
                  capabilities: {},
                  runtimeAdapters: [],
                },
              ],
              hooks: [
                {
                  hookApiVersion: 1,
                  id: 'backend.terminalRuntime.bindTranscript',
                  category: 'integration',
                  scope: 'backend',
                  handler: {
                    target: 'plugin',
                    exportName: 'bindTranscript',
                  },
                },
              ],
            },
            source: {
              kind: 'archive',
              locator: `${url.origin}/plugins/acme.sample.tar.gz`,
              trustPolicy: 'prompt',
              installPolicy: 'managed_install',
            },
          },
        ],
      }));
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

describe('handlePluginsCommand', () => {
  it('renders the plugins help page', async () => {
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['help']);

      expect(output.text()).toContain('happier plugins');
      expect(output.text()).toContain('happier plugins list [--json]');
      expect(output.text()).toContain('happier plugins install <path> [--dry-run] [--force] [--json]');
      expect(output.text()).toContain('happier plugins marketplace list <catalogUrl> [--json]');
    } finally {
      output.restore();
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

        expect(parsed.ok).toBe(true);
        expect(parsed.kind).toBe('plugins_install');
        expect(parsed.data?.alreadyInstalled).toBe(false);
        expect(parsed.data?.plugin.pluginId).toBe(SAMPLE_PLUGIN_ID);
        expect(parsed.data?.plugin.title).toBe('Acme Sample');
        expect(parsed.data?.plugin.contributions.providers).toEqual(['acme.sample.provider']);
        expect(parsed.data?.plugin.contributions.backends).toEqual(['acme.sample.backend']);
        expect(parsed.data?.plugin.contributions.hooks).toEqual(['backend.terminalRuntime.bindTranscript']);
      } finally {
        output.restore();
      }
    } finally {
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
        expect(parsed.data.plugins[0].contributions.hooks).toEqual(['backend.terminalRuntime.bindTranscript']);
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
        expect(parsed.data.plugin.contributions.hooks).toEqual(['backend.terminalRuntime.bindTranscript']);
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
        expect(parsed.data.plugin.contributions.providers).toEqual(['acme.sample.provider']);
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
        expect(parsed.data.plugins[0].contributions.hooks).toEqual(['backend.terminalRuntime.bindTranscript']);
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
