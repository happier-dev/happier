import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';
import { configuration, reloadConfiguration } from '@/configuration';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { inspectPluginSource } from '@/plugins/store/install/source';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { runInstallCliCommand } from './install';

const { resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
  resolveMergedContributionRegistryMock: vi.fn(),
}));

const daemonBoundary = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemon', () => ({
  ensureDaemonRunningForSessionCommand: daemonBoundary.ensureRunning,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemonBoundary.requestChange,
  decideDaemonPluginChange: daemonBoundary.decideChange,
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

function makeDeps(overrides: Partial<NonNullable<Parameters<typeof runInstallCliCommand>[1]>> = {}) {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    runDoctorCommand: vi.fn(),
    invokeAgentCliInstall: vi.fn(),
    runPluginsCommand: vi.fn(),
    ...overrides,
  };
}

describe('runInstallCliCommand', () => {
  beforeEach(() => {
    daemonBoundary.ensureRunning.mockClear();
    daemonBoundary.requestChange.mockReset();
    daemonBoundary.decideChange.mockReset();
    resolveMergedContributionRegistryMock.mockReset();
    resolveMergedContributionRegistryMock.mockResolvedValue({
      agents: [
        {
          id: 'claude',
          provenance: 'first_party',
          source: { kind: 'bundled' },
          definition: {
            kindVersion: 1,
            id: 'claude',
            ownedBackendIds: [],
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
        ...[
          {
            id: 'codex',
            title: 'OpenAI Codex CLI',
            binaryName: 'codex',
            provenance: 'first_party' as const,
            managedInstall: {
              kind: 'github_release_binary' as const,
              githubRepo: 'openai/codex',
              binaryName: 'codex',
            },
          },
          {
            id: 'gemini',
            title: 'Google Gemini CLI',
            binaryName: 'gemini',
            provenance: 'first_party' as const,
            managedInstall: {
              kind: 'managed_package' as const,
              packageName: '@google/gemini-cli',
              binaryName: 'gemini',
            },
          },
          {
            id: 'acme-agent',
            title: 'Acme Agent CLI',
            binaryName: 'acme-agent',
            provenance: 'external' as const,
            managedInstall: {
              kind: 'managed_package' as const,
              packageName: '@acme/agent-cli',
              binaryName: 'acme-agent',
            },
          },
        ].map((agent) => ({
          id: agent.id,
          provenance: agent.provenance,
          source: { kind: agent.provenance === 'external' ? 'package' : 'bundled' },
          definition: {
            kindVersion: 1,
            id: agent.id,
            ownedBackendIds: [],
          },
          runtimeSpec: {
            kindVersion: 1,
            id: agent.id,
            title: agent.title,
            binaryName: agent.binaryName,
            sourcePreferenceDefault: 'system-first',
            managedInstall: agent.managedInstall,
            manualInstallKind: 'command',
            manualInstallRecipes: null,
            acceptsJavaScriptFileOverride: false,
          },
          catalogEntry: null,
        })),
      ],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      agentDefinitionsById: new Map(),
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
      invokeAgentCliInstall: vi.fn(),
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install provider <providerId>'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install doctor'));
    // Plugin lifecycle commands live only behind the canonical `happier plugins`
    // owner; the install helper must not advertise a second spelling.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('happier install plugin'));
  });

  it('redirects the released plugin spelling to the canonical plugins install owner', async () => {
    const log = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const runPluginsCommand = vi.fn();

    await runInstallCliCommand(makeContext(['install', 'plugin', 'acme.sample']), {
      log,
      error,
      exit,
      runDoctorCommand: vi.fn(),
      invokeAgentCliInstall: vi.fn(),
      runPluginsCommand,
    });

    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(runPluginsCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: ['plugins', 'install', 'acme.sample'],
    }));
    expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
  });

  it('redirects the released plugin update spelling without retaining an install-owned update path', async () => {
    const runPluginsCommand = vi.fn();

    await runInstallCliCommand(
      makeContext(['install', 'plugin', 'update', 'acme.sample', '--json']),
      makeDeps({ runPluginsCommand }),
    );

    expect(runPluginsCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: ['plugins', 'update', 'acme.sample', '--json'],
    }));
    expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
  });

  it('prints usage for provider help requests', async () => {
    const log = vi.fn();
    const error = vi.fn();

    await runInstallCliCommand(makeContext(['install', 'provider', '--help']), {
      log,
      error,
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeAgentCliInstall: vi.fn(),
    });

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('happier install provider <providerId>'));
  });

  it('invokes provider installs in dry-run mode and prints the plan', async () => {
    const log = vi.fn();
    const invokeAgentCliInstall = vi.fn().mockResolvedValue({
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
      invokeAgentCliInstall,
    });

    expect(invokeAgentCliInstall).toHaveBeenCalledWith({
      agentId: 'codex',
      runtimeSpec: expect.objectContaining({ id: 'codex', title: 'OpenAI Codex CLI' }),
      params: { dryRun: true, skipIfInstalled: true },
      env: process.env,
      nodePlatform: process.platform,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Dry run: would install OpenAI Codex CLI'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/tmp/codex-install.log'));
  });

  it('passes force installs through as skipIfInstalled false', async () => {
    const invokeAgentCliInstall = vi.fn().mockResolvedValue({
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
      invokeAgentCliInstall,
    });

    expect(invokeAgentCliInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'gemini',
        params: { dryRun: false, skipIfInstalled: false },
      }),
    );
  });

  it('installs an external Agent from its normalized CLI descriptor', async () => {
    const invokeAgentCliInstall = vi.fn().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: null,
      plan: {
        agentId: 'acme-agent',
        title: 'Acme Agent CLI',
        binaries: ['acme-agent'],
        platform: 'linux',
        docsUrl: null,
        commands: [],
        requiresAdmin: false,
        installMode: 'managed_package',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@acme/agent-cli',
          binaryName: 'acme-agent',
        },
      },
    });
    const log = vi.fn();

    await runInstallCliCommand(makeContext(['install', 'provider', 'acme-agent']), {
      log,
      error: vi.fn(),
      exit: vi.fn() as never,
      runDoctorCommand: vi.fn(),
      invokeAgentCliInstall,
    });

    expect(invokeAgentCliInstall).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'acme-agent',
      runtimeSpec: expect.objectContaining({
        id: 'acme-agent',
        title: 'Acme Agent CLI',
        binaryName: 'acme-agent',
      }),
    }));
    expect(log).toHaveBeenCalledWith('Installed Acme Agent CLI via managed package runtime.');
  });

  it('defaults vendor recipe execution for explicit provider installs', async () => {
    const invokeAgentCliInstall = vi.fn().mockResolvedValue({
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
      invokeAgentCliInstall,
    });

    expect(invokeAgentCliInstall).toHaveBeenCalledWith(
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
      invokeAgentCliInstall: vi.fn(),
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
      invokeAgentCliInstall: vi.fn().mockRejectedValue(new Error('network stalled')),
    });

    expect(error).toHaveBeenCalledWith(expect.any(String), 'network stalled');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('cleans up archive staging directories when extraction fails', async () => {
    const home = await createTempDir('happier-plugin-install-');
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: process.env.PATH ?? '' });
    reloadConfiguration();

    const corruptArchivePath = join(home, 'corrupt-plugin.tar.gz');
    await writeFile(corruptArchivePath, 'not a real archive', 'utf8');

    try {
      const result = await inspectPluginSource({
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
