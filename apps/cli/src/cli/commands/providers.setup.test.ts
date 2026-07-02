import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const { installProviderCliForRuntime } = vi.hoisted(() => ({
  installProviderCliForRuntime: vi.fn(async (_params: Readonly<{ runtimeSpec: { id: string } }>) => ({
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

vi.mock('@happier-dev/cli-common/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/providers')>();
  return {
    ...actual,
    installProviderCliForRuntime,
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

import { handleProvidersCommand } from './providers';

describe('happier providers setup --yes --json', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);

  beforeEach(async () => {
    installProviderCliForRuntime.mockReset();
    resolveMergedContributionRegistryMock.mockReset();
    getAgentCliSetupRecommendedIdsMock.mockClear();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    home = await createTempDir('happier-providers-setup-');
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();

    const providerContributions = [
      {
        id: 'claude',
        source: 'built-in' as const,
        definition: {
          id: 'claude',
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
        source: 'built-in' as const,
        definition: {
          id: 'codex',
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
      providers: providerContributions,
      backends: [],
      hookRegistrations: [],
      runtimeAdaptersByBackendId: new Map(),
      catalogEntriesById: {},
      providerDefinitionsById: new Map(providerContributions.map((provider) => [provider.id, provider] as const)),
      backendDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: {},
    });
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (home) await removeTempDir(home);
  });

  it('installs recommended providers without prompting', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['setup', '--yes', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('providers_setup');
      expect(Array.isArray(parsed.data?.providers)).toBe(true);
      expect(parsed.data.providers.length).toBeGreaterThan(0);

      const installedIds = installProviderCliForRuntime.mock.calls.map((call) => call[0].runtimeSpec.id);
      expect(installedIds).toEqual([...getAgentCliSetupRecommendedIdsMock()]);
    } finally {
      output.restore();
    }
  });

  it('accepts --providers comma-separated selection in non-interactive mode', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleProvidersCommand(['setup', '--providers', 'claude,codex', '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed.ok).toBe(true);

      const installedIds = installProviderCliForRuntime.mock.calls.map((call) => call[0].runtimeSpec.id);
      expect(installedIds).toEqual(['claude', 'codex']);
    } finally {
      output.restore();
    }
  });

  it('rejects unsupported provider ids such as customAcp', async () => {
    await expect(handleProvidersCommand(['setup', '--providers', 'customAcp', '--json'])).rejects.toThrow(
      /Unsupported provider id\(s\) for setup/i,
    );
  });
});
