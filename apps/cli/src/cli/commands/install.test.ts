import { describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';

import { runInstallCliCommand } from './install';

function makeContext(args: string[]): CommandContext {
  return {
    args,
    rawArgv: ['happier', ...args],
    terminalRuntime: null,
  };
}

describe('runInstallCliCommand', () => {
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
});
