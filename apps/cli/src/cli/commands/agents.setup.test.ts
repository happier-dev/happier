import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const { installAgentCliForRuntime } = vi.hoisted(() => ({
  installAgentCliForRuntime: vi.fn(async (_params: Readonly<{ runtimeSpec: { id: string } }>) => ({
    ok: true as const,
    alreadyInstalled: false,
    plan: { installMode: 'managed_package' } as any,
    logPath: null,
  })),
}));

const { resolveMergedContributionRegistryMock, getAgentCliSetupRecommendedIdsMock } = vi.hoisted(() => ({
  resolveMergedContributionRegistryMock: vi.fn(),
  getAgentCliSetupRecommendedIdsMock: vi.fn(() => ['claude', 'codex']),
}));

vi.mock('@happier-dev/cli-common/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/agents')>();
  return {
    ...actual,
    installAgentCliForRuntime,
  };
});

vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  return {
    ...actual,
    getAgentCliSetupRecommendedIds: getAgentCliSetupRecommendedIdsMock,
  };
});

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
});

import { handleAgentsCommand } from './agents';

describe('happier agents setup --yes --json', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    installAgentCliForRuntime.mockReset();
    resolveMergedContributionRegistryMock.mockReset();
    getAgentCliSetupRecommendedIdsMock.mockClear();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-agents-setup-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const providerContributions = [
      {
        id: 'claude',
        provenance: 'first_party' as const,
        source: { kind: 'bundled' as const },
        definition: {
          kindVersion: 1,
          id: 'claude',
          ownedBackendIds: [],
        },
        runtimeSpec: {
          kindVersion: 1,
          id: 'claude',
          title: 'Claude CLI',
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
      },
      {
        id: 'codex',
        provenance: 'first_party' as const,
        source: { kind: 'bundled' as const },
        definition: {
          kindVersion: 1,
          id: 'codex',
          ownedBackendIds: [],
        },
        runtimeSpec: {
          kindVersion: 1,
          id: 'codex',
          title: 'Codex CLI',
          binaryName: 'codex',
          sourcePreferenceDefault: 'system-first',
          managedInstall: {
            kind: 'managed_package',
            packageName: '@happier-dev/codex',
            binaryName: 'codex',
          },
          manualInstallKind: 'command',
          manualInstallRecipes: null,
          acceptsJavaScriptFileOverride: false,
        },
      },
    ];

    resolveMergedContributionRegistryMock.mockResolvedValue({
      agents: providerContributions,
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      agentDefinitionsById: new Map(providerContributions.map((provider) => [provider.id, provider] as const)),
            pluginDiagnosticsByPluginId: {},
    });
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('installs recommended agents without prompting', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['setup', '--yes', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('agents_setup');
      expect(Array.isArray(parsed.data?.agents)).toBe(true);
      expect(parsed.data.agents.length).toBeGreaterThan(0);

      const installedIds = installAgentCliForRuntime.mock.calls.map((call) => call[0].runtimeSpec.id);
      expect(installedIds).toEqual([...getAgentCliSetupRecommendedIdsMock()]);
    } finally {
      output.restore();
    }
  });

  it('accepts --providers comma-separated selection in non-interactive mode', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['setup', '--providers', 'claude,codex', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);

      const installedIds = installAgentCliForRuntime.mock.calls.map((call) => call[0].runtimeSpec.id);
      expect(installedIds).toEqual(['claude', 'codex']);
    } finally {
      output.restore();
    }
  });

  it('prints a typed agents_setup JSON error for unsupported agent ids', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['setup', '--providers', 'customAcp', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('agents_setup');
      expect(parsed.error).toEqual({
        code: 'unsupported_agent',
        message: 'Unsupported agent id(s) for setup: customAcp',
        agentIds: ['customAcp'],
      });
    } finally {
      output.restore();
    }
  });
});
