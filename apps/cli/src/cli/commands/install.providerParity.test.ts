import { describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({
    agents: [{
      id: 'acme-agent',
      provenance: 'external',
      source: { kind: 'package' },
      definition: { kindVersion: 1, id: 'acme-agent', ownedBackendIds: [] },
      runtimeSpec: {
        kindVersion: 1,
        id: 'acme-agent',
        title: 'Acme Agent CLI',
        binaryName: 'acme-agent',
        sourcePreferenceDefault: 'system-first',
        managedInstall: {
          kind: 'managed_package',
          packageName: '@acme/agent-cli',
          binaryName: 'acme-agent',
        },
        manualInstallKind: 'command',
        manualInstallRecipes: null,
        acceptsJavaScriptFileOverride: false,
      },
      catalogEntry: null,
    }],
  })),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  resolveMergedContributionRegistry: registry.resolve,
}));
vi.mock('@/plugins/store/paths', () => ({ resolvePluginStorePaths: () => ({ happyHomeDir: '/tmp/happier' }) }));
vi.mock('@/plugins/daemon/changeClient', () => ({
  requestUserPluginChange: vi.fn(),
  resolveUserPluginChangeApproval: vi.fn(),
}));
vi.mock('@/plugins/distribution/archive/integrity', () => ({ resolveArchiveExpectedIntegrity: vi.fn() }));
vi.mock('@/plugins/store/registry/currentState', () => ({ createPluginRegistryStateStore: vi.fn() }));
vi.mock('@/terminal/prompts/promptInput', () => ({ isInteractiveTerminal: () => false }));

import type { CommandContext } from '@/cli/commandRegistry';
import { runInstallCliCommand } from './install';

describe('happier install provider contribution parity', () => {
  it('passes an external Agent normalized CLI descriptor to the host installer', async () => {
    const invokeAgentCliInstall = vi.fn(async () => ({
      ok: true as const,
      alreadyInstalled: false,
      logPath: null,
      plan: {
        agentId: 'acme-agent',
        title: 'Acme Agent CLI',
        binaries: ['acme-agent'],
        platform: 'linux' as const,
        docsUrl: null,
        commands: [],
        requiresAdmin: false,
        installMode: 'managed_package' as const,
        managedInstall: {
          kind: 'managed_package' as const,
          packageName: '@acme/agent-cli',
          binaryName: 'acme-agent',
        },
      },
    }));
    const log = vi.fn();
    const context: CommandContext = {
      args: ['install', 'provider', 'acme-agent'],
      rawArgv: ['happier', 'install', 'provider', 'acme-agent'],
      terminalRuntime: null,
    };

    await runInstallCliCommand(context, {
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
      }),
    }));
    expect(log).toHaveBeenCalledWith('Installed Acme Agent CLI via managed package runtime.');
  });
});
