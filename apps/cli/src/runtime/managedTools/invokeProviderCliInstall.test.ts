import { describe, expect, it, vi } from 'vitest';

import type { InstallProviderCliResult } from '@happier-dev/cli-common/providers';

import { invokeProviderCliInstall } from './invokeProviderCliInstall';

describe('invokeProviderCliInstall', () => {
  it('returns unsupported-platform when the current platform cannot install provider CLIs', async () => {
    const result = await invokeProviderCliInstall({
      agentId: 'codex',
      nodePlatform: 'aix',
      installProviderCli: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported-platform',
      errorMessage: 'Unsupported platform: aix',
      logPath: null,
    });
  });

  it('keeps vendor recipe execution disabled for dry-run installs', async () => {
    const installProviderCli = vi.fn<(...args: any[]) => Promise<InstallProviderCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/install.log',
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

    const result = await invokeProviderCliInstall({
      agentId: 'codex',
      nodePlatform: 'linux',
      params: { dryRun: true },
      env: { TEST_ENV: '1' },
      installProviderCli,
    });

    expect(installProviderCli).toHaveBeenCalledWith({
      providerId: 'codex',
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
        providerId: 'codex',
        installMode: 'github_release_binary',
      }),
    });
  });

  it('defaults vendor recipe execution on for explicit real installs', async () => {
    const installProviderCli = vi.fn<(...args: any[]) => Promise<InstallProviderCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/claude-install.log',
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

    await invokeProviderCliInstall({
      agentId: 'claude',
      nodePlatform: 'linux',
      installProviderCli,
    });

    expect(installProviderCli).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'claude',
        dryRun: false,
        allowVendorRecipeExecution: true,
      }),
    );
  });

  it('treats force installs as skipIfInstalled false', async () => {
    const installProviderCli = vi.fn<(...args: any[]) => Promise<InstallProviderCliResult>>().mockResolvedValue({
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

    await invokeProviderCliInstall({
      agentId: 'gemini',
      nodePlatform: 'linux',
      params: { skipIfInstalled: false },
      installProviderCli,
    });

    expect(installProviderCli).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'gemini',
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
      }),
    );
  });

  it('passes allowVendorRecipeExecution through when explicitly set', async () => {
    const installProviderCli = vi.fn<(...args: any[]) => Promise<InstallProviderCliResult>>().mockResolvedValue({
      ok: true,
      alreadyInstalled: false,
      logPath: '/tmp/claude-install.log',
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

    await invokeProviderCliInstall({
      agentId: 'claude',
      nodePlatform: 'linux',
      params: { allowVendorRecipeExecution: true },
      installProviderCli,
    });

    expect(installProviderCli).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'claude',
        allowVendorRecipeExecution: true,
      }),
    );
  });

  it('maps no-recipe failures to install-not-available', async () => {
    const installProviderCli = vi.fn<(...args: any[]) => Promise<InstallProviderCliResult>>().mockResolvedValue({
      ok: false,
      errorCode: 'no-recipe',
      errorMessage: 'No auto-install recipe available for kiro on linux.',
      plan: null,
      logPath: null,
    });

    const result = await invokeProviderCliInstall({
      agentId: 'kiro',
      nodePlatform: 'linux',
      installProviderCli,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'install-not-available',
      errorMessage: 'No auto-install recipe available for kiro on linux.',
      logPath: null,
    });
  });
});
