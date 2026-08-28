import { describe, expect, it, vi } from 'vitest';

import type { InstallAgentCliResult } from '@happier-dev/cli-common/agents';

import { invokeAgentCliInstall } from './invokeAgentCliInstall';

describe('invokeAgentCliInstall', () => {
  it('installs an external Agent through its normalized runtime descriptor', async () => {
    const runtimeSpec = {
      kindVersion: 1 as const,
      id: 'acme-agent',
      title: 'Acme Agent CLI',
      binaryName: 'acme-agent',
      sourcePreferenceDefault: 'system-first' as const,
      managedInstall: {
        kind: 'managed_package' as const,
        packageName: '@acme/agent-cli',
        binaryName: 'acme-agent',
      },
      manualInstallKind: 'command' as const,
      manualInstallRecipes: null,
      acceptsJavaScriptFileOverride: false,
    };
    const installAgentCliForRuntime = vi.fn<(...args: any[]) => Promise<InstallAgentCliResult>>()
      .mockResolvedValue({
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
          managedInstall: runtimeSpec.managedInstall,
        },
      });
    const bundledInstaller = vi.fn();

    await invokeAgentCliInstall({
      agentId: 'acme-agent',
      runtimeSpec,
      nodePlatform: 'linux',
      installAgentCli: bundledInstaller,
      installAgentCliForRuntime,
    });

    expect(installAgentCliForRuntime).toHaveBeenCalledWith(expect.objectContaining({ runtimeSpec }));
    expect(bundledInstaller).not.toHaveBeenCalled();
  });

  it('returns unsupported-platform when the current platform cannot install agent CLIs', async () => {
    const result = await invokeAgentCliInstall({
      agentId: 'codex',
      nodePlatform: 'aix',
      installAgentCli: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported-platform',
      errorMessage: 'Unsupported platform: aix',
      logPath: null,
    });
  });

  it('keeps vendor recipe execution disabled for dry-run installs', async () => {
    const installAgentCli = vi.fn<(...args: any[]) => Promise<InstallAgentCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/install.log',
      plan: {
        agentId: 'codex',
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

    const result = await invokeAgentCliInstall({
      agentId: 'codex',
      nodePlatform: 'linux',
      params: { dryRun: true },
      env: { TEST_ENV: '1' },
      installAgentCli,
    });

    expect(installAgentCli).toHaveBeenCalledWith({
      agentId: 'codex',
      platform: 'linux',
      dryRun: true,
      skipIfInstalled: true,
      allowVendorRecipeExecution: false,
      env: { TEST_ENV: '1' },
    });
    expect(result).toEqual({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/install.log',
      plan: expect.objectContaining({
        agentId: 'codex',
        installMode: 'github_release_binary',
      }),
    });
  });

  it('defaults vendor recipe execution on for explicit real installs', async () => {
    const installAgentCli = vi.fn<(...args: any[]) => Promise<InstallAgentCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/claude-install.log',
      plan: {
        agentId: 'claude',
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

    await invokeAgentCliInstall({
      agentId: 'claude',
      nodePlatform: 'linux',
      installAgentCli,
    });

    expect(installAgentCli).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        dryRun: false,
        allowVendorRecipeExecution: true,
      }),
    );
  });

  it('treats force installs as skipIfInstalled false', async () => {
    const installAgentCli = vi.fn<(...args: any[]) => Promise<InstallAgentCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: null,
      plan: {
        agentId: 'gemini',
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

    await invokeAgentCliInstall({
      agentId: 'gemini',
      nodePlatform: 'linux',
      params: { skipIfInstalled: false },
      installAgentCli,
    });

    expect(installAgentCli).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'gemini',
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
      }),
    );
  });

  it('forces explicit managed updates past installed-runtime preflight', async () => {
    const installAgentCli = vi.fn<(...args: any[]) => Promise<InstallAgentCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: null,
      plan: {
        agentId: 'codex',
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

    await invokeAgentCliInstall({
      agentId: 'codex',
      nodePlatform: 'linux',
      params: { intent: 'update', skipIfInstalled: true },
      installAgentCli,
    });

    expect(installAgentCli).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex',
        intent: 'update',
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
      }),
    );
  });

  it('passes allowVendorRecipeExecution through when explicitly set', async () => {
    const installAgentCli = vi.fn<(...args: any[]) => Promise<InstallAgentCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/claude-install.log',
      plan: {
        agentId: 'claude',
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

    await invokeAgentCliInstall({
      agentId: 'claude',
      nodePlatform: 'linux',
      params: { allowVendorRecipeExecution: true },
      installAgentCli,
    });

    expect(installAgentCli).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        allowVendorRecipeExecution: true,
      }),
    );
  });

  it('maps no-recipe failures to install-not-available', async () => {
    const installAgentCli = vi.fn<(...args: any[]) => Promise<InstallAgentCliResult>>().mockResolvedValue({
      ok: false,
      errorCode: 'no-recipe',
      errorMessage: 'No auto-install recipe available for kiro on linux.',
      plan: null,
      logPath: null,
    });

    const result = await invokeAgentCliInstall({
      agentId: 'kiro',
      nodePlatform: 'linux',
      installAgentCli,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'install-not-available',
      errorMessage: 'No auto-install recipe available for kiro on linux.',
      logPath: null,
    });
  });
});
