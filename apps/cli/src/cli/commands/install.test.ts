import { createServer } from 'node:http';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';
import { reloadConfiguration } from '@/configuration';
import { createPluginStateStore } from '@/plugins/store/state';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { installPluginFromSource } from '@/plugins/store/install/source';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { materializeSamplePluginFixture } from '@/plugins/testkit/samplePackage';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { runInstallCliCommand } from './install';

const { resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
  resolveMergedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
});

function makeContext(args: string[]): CommandContext {
  return {
    args,
    rawArgv: ['happier', ...args],
    terminalRuntime: null,
  };
}

async function createArchivedSamplePluginFixture(rootName = 'sample-plugin'): Promise<Readonly<{
  pluginSourceRoot: string;
  archiveRoot: string;
  archivePath: string;
  rewriteManifestVersion: (version: string) => Promise<void>;
  rebuildArchive: () => Promise<void>;
}>> {
  const pluginSourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-'));
  const archiveRoot = join(pluginSourceRoot, rootName);
  await materializeSamplePluginFixture(archiveRoot);
  const archivePath = join(pluginSourceRoot, `${rootName}.tar.gz`);

  const rebuildArchive = async (): Promise<void> => {
    await rm(archivePath, { force: true });
    await tar.c({
      gzip: true,
      file: archivePath,
      cwd: pluginSourceRoot,
      portable: true,
    }, [rootName]);
  };

  const rewriteManifestVersion = async (version: string): Promise<void> => {
    const manifestPath = join(archiveRoot, '.happier-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version }, null, 2));
  };

  await rebuildArchive();
  return {
    pluginSourceRoot,
    archiveRoot,
    archivePath,
    rewriteManifestVersion,
    rebuildArchive,
  } as const;
}

describe('runInstallCliCommand', () => {
  beforeEach(() => {
    resolveMergedContributionRegistryMock.mockReset();
    resolveMergedContributionRegistryMock.mockResolvedValue({
      providers: [
        {
          id: 'claude',
          source: 'built-in',
          definition: {
            id: 'claude',
          },
          runtimeSpec: {
            kindVersion: 1,
            id: 'claude',
            title: 'Claude Code CLI',
            binaryName: 'claude',
            sourcePreferenceDefault: 'system-first',
            managedInstall: {
              kind: 'managed_package',
              packageName: '@happier-dev/claude',
              binaryName: 'claude',
            },
            manualInstallKind: 'command',
            manualInstallRecipes: null,
            acceptsJavaScriptFileOverride: false,
          },
          catalogEntry: null,
        },
      ],
      backends: [],
      hookRegistrations: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      providerDefinitionsById: new Map(),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    });
  });

  it('prints usage for help requests', async () => {
    const log = vi.fn();

    await runInstallCliCommand(makeContext(['install', '--help']), {
      log,
      error: vi.fn(),
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeProviderCliInstall: vi.fn(),
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install provider <providerId>'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install plugin <path|archive-url>'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install doctor'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install plugin update <pluginId>'));
  });

  it('prints usage for provider help requests', async () => {
    const log = vi.fn();
    const error = vi.fn();

    await runInstallCliCommand(makeContext(['install', 'provider', '--help']), {
      log,
      error,
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeProviderCliInstall: vi.fn(),
    });

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install provider <providerId>'));
  });

  it('invokes provider installs in dry-run mode and prints the plan', async () => {
    const log = vi.fn();
    const invokeProviderCliInstall = vi.fn().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/codex-install.log',
      plan: {
        providerId: 'codex',
        title: 'OpenAI Codex CLI',
        binaries: ['codex'],
        platform: 'linux',
        docsUrl: 'https://github.com/openai/codex',
        commands: [],
        requiresAdmin: false,
        installMode: 'github_release_binary',
        managedInstall: {
          kind: 'github_release_binary',
          githubRepo: 'openai/codex',
          binaryName: 'codex',
        },
      },
    });

    await runInstallCliCommand(makeContext(['install', 'provider', 'codex', '--dry-run']), {
      log,
      error: vi.fn(),
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeProviderCliInstall,
    });

    expect(invokeProviderCliInstall).toHaveBeenCalledWith({
      agentId: 'codex',
      params: { dryRun: true, skipIfInstalled: true },
      env: process.env,
      nodePlatform: process.platform,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Dry run: would install OpenAI Codex CLI'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/tmp/codex-install.log'));
  });

  it('passes force installs through as skipIfInstalled false', async () => {
    const invokeProviderCliInstall = vi.fn().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: null,
      plan: {
        providerId: 'gemini',
        title: 'Google Gemini CLI',
        binaries: ['gemini'],
        platform: 'linux',
        docsUrl: 'https://goo.gle/gemini-cli-auth-docs',
        commands: [],
        requiresAdmin: false,
        installMode: 'managed_package',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@google/gemini-cli',
          binaryName: 'gemini',
        },
      },
    });

    await runInstallCliCommand(makeContext(['install', 'provider', 'gemini', '--force']), {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeProviderCliInstall,
    });

    expect(invokeProviderCliInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'gemini',
        params: { dryRun: false, skipIfInstalled: false },
      }),
    );
  });

  it('defaults vendor recipe execution for explicit provider installs', async () => {
    const invokeProviderCliInstall = vi.fn().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: null,
      plan: {
        providerId: 'claude',
        title: 'Claude Code CLI',
        binaries: ['claude'],
        platform: 'linux',
        docsUrl: 'https://claude.ai',
        commands: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'], requiresAdmin: false, note: null }],
        requiresAdmin: false,
        installMode: 'vendor_recipe',
        managedInstall: null,
      },
    });

    await runInstallCliCommand(makeContext(['install', 'provider', 'claude']), {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeProviderCliInstall,
    });

    expect(invokeProviderCliInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        params: { dryRun: false, skipIfInstalled: true },
      }),
    );
  });

  it('rejects unknown provider ids with a non-zero exit', async () => {
    const error = vi.fn();
    const exit = vi.fn();

    await runInstallCliCommand(makeContext(['install', 'provider', 'not-a-provider']), {
      log: vi.fn(),
      error,
      exit,
      runDoctorCommand: vi.fn(),
      invokeProviderCliInstall: vi.fn(),
    });

    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Unknown provider id: not-a-provider'),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('surfaces unexpected provider install failures instead of rejecting silently', async () => {
    const error = vi.fn();
    const exit = vi.fn();

    await runInstallCliCommand(makeContext(['install', 'provider', 'codex']), {
      log: vi.fn(),
      error,
      exit,
      runDoctorCommand: vi.fn(),
      invokeProviderCliInstall: vi.fn().mockRejectedValue(new Error('network stalled')),
    });

    expect(error).toHaveBeenCalledWith(expect.any(String), 'network stalled');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('installs archive-backed plugins into the managed plugin store and loads them from the installed payload', async () => {
    const home = await createTempDir('happier-plugin-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();

    try {
      await runInstallCliCommand(makeContext(['install', 'plugin', archivePath, '--kind', 'archive']));

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(Object.keys(state.plugins)).toEqual(['acme.sample']);
      expect(state.plugins['acme.sample']).toMatchObject({
        source: {
          kind: 'archive',
          locator: archivePath,
        },
        install: {
          mode: 'managed_install',
        },
      });

      const loaded = await loadInstalledPlugins({ happyHomeDir: home });
      expect(loaded.loadedPlugins.map((plugin) => plugin.manifest.id)).toEqual(['acme.sample']);
      expect(loaded.loadedPlugins[0]).toMatchObject({
        sourceSpec: {
          kind: 'archive',
          locator: archivePath,
          installPolicy: 'managed_install',
        },
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('installs direct archive URLs through the canonical archive installer and preserves remote provenance', async () => {
    const home = await createTempDir('happier-plugin-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();
    const archiveBytes = await readFile(archivePath);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname === '/plugins/acme.sample.tar.gz') {
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': String(archiveBytes.byteLength),
        });
        res.end(archiveBytes);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind direct archive install test server');
    }
    const archiveUrl = `http://127.0.0.1:${address.port}/plugins/acme.sample.tar.gz?download=1`;

    try {
      await runInstallCliCommand(makeContext(['install', 'plugin', archiveUrl]));

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(Object.keys(state.plugins)).toEqual(['acme.sample']);
      expect(state.plugins['acme.sample']).toMatchObject({
        source: {
          kind: 'archive',
          locator: archiveUrl,
          trustPolicy: 'prompt',
        },
        install: {
          mode: 'managed_install',
        },
      });

      const loaded = await loadInstalledPlugins({ happyHomeDir: home });
      expect(loaded.loadedPlugins.map((plugin) => plugin.manifest.id)).toEqual(['acme.sample']);
      expect(loaded.loadedPlugins[0]).toMatchObject({
        sourceSpec: {
          kind: 'archive',
          locator: archiveUrl,
          trustPolicy: 'prompt',
          installPolicy: 'managed_install',
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('updates an archive-backed plugin by rehydrating the managed payload from the stored archive source', async () => {
    const home = await createTempDir('happier-plugin-update-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath, rewriteManifestVersion, rebuildArchive } = await createArchivedSamplePluginFixture();

    try {
      await runInstallCliCommand(makeContext(['install', 'plugin', archivePath, '--kind', 'archive']));
      await rewriteManifestVersion('2.0.0');
      await rebuildArchive();

      await runInstallCliCommand(makeContext(['install', 'plugin', 'update', 'acme.sample']));

      const store = createPluginStateStore({ happyHomeDir: home });
      const state = await store.read();
      expect(state.plugins['acme.sample']).toMatchObject({
        install: {
          mode: 'managed_install',
          manifestVersion: '2.0.0',
        },
      });

      const loaded = await loadInstalledPlugins({ happyHomeDir: home });
      expect(loaded.loadedPlugins).toHaveLength(1);
      expect(loaded.loadedPlugins[0]).toMatchObject({
        manifest: {
          id: 'acme.sample',
          version: '2.0.0',
        },
        sourceSpec: {
          kind: 'archive',
          locator: archivePath,
          installPolicy: 'managed_install',
        },
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('removes an archive-backed plugin and deletes its managed payload', async () => {
    const home = await createTempDir('happier-plugin-remove-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const { pluginSourceRoot, archivePath } = await createArchivedSamplePluginFixture();

    try {
      await runInstallCliCommand(makeContext(['install', 'plugin', archivePath, '--kind', 'archive']));

      const storeBefore = createPluginStateStore({ happyHomeDir: home });
      const stateBefore = await storeBefore.read();
      const installedPath = stateBefore.plugins['acme.sample']?.install.installedPath;
      expect(typeof installedPath).toBe('string');

      const publishInstalledManifestProjections = vi.fn(async () => undefined);
      await runInstallCliCommand(makeContext(['install', 'plugin', 'remove', 'acme.sample']), {
        log: console.log,
        error: console.error,
        exit: (code: number) => {
          process.exitCode = code;
        },
        runDoctorCommand: vi.fn(),
        invokeProviderCliInstall: vi.fn(),
        publishInstalledManifestProjections,
      });

      const storeAfter = createPluginStateStore({ happyHomeDir: home });
      const stateAfter = await storeAfter.read();
      expect(stateAfter.plugins).toEqual({});

      const loaded = await loadInstalledPlugins({ happyHomeDir: home });
      expect(loaded.loadedPlugins).toEqual([]);
      expect(publishInstalledManifestProjections).toHaveBeenCalledWith({
        pluginIds: ['acme.sample'],
      });
      if (installedPath) {
        await expect(access(installedPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
      await rm(pluginSourceRoot, { recursive: true, force: true });
    }
  });

  it('cleans up archive staging directories when extraction fails', async () => {
    const home = await createTempDir('happier-plugin-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const corruptArchivePath = join(home, 'corrupt-plugin.tar.gz');
    await writeFile(corruptArchivePath, 'not a real archive', 'utf8');

    try {
      const result = await installPluginFromSource({
        happyHomeDir: home,
        locator: corruptArchivePath,
        sourceKind: 'archive',
        skipIfInstalled: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorCode).toBe('plugin_install_failed');

      const store = createPluginStateStore({ happyHomeDir: home });
      const cacheEntries = await readdir(store.paths.cacheDir);
      expect(cacheEntries.filter((entry) => entry.startsWith('plugin-install-'))).toHaveLength(0);
    } finally {
      envScope.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });
});
