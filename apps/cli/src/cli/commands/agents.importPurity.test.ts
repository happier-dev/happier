import { describe, expect, it, vi } from 'vitest';

import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const { resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
  resolveMergedContributionRegistryMock: vi.fn(),
}));

vi.mock('@/rpc/handlers/capabilities', () => {
  throw new Error('agents list/status must not import the capability service');
});

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
  };
});

function seedProviderRegistry(): void {
  resolveMergedContributionRegistryMock.mockResolvedValue({
    agents: [
      {
        id: 'acme.providers.list',
        source: 'built-in',
        definition: { id: 'acme.providers.list' },
        runtimeSpec: {
          kindVersion: 1,
          id: 'acme.providers.list',
          title: 'Acme Providers List',
          binaryName: 'acme-providers-list',
          sourcePreferenceDefault: 'system-first',
          managedInstall: null,
          manualInstallKind: 'command',
          manualInstallRecipes: null,
          acceptsJavaScriptFileOverride: false,
        },
      },
    ],
    backends: [],
    runtimeAdaptersByBackendId: new Map(),
    catalogEntriesById: {},
    agentDefinitionsById: new Map(),
    backendDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
  });
}

describe('happier agents read-only JSON import purity', () => {
  it.each([
    ['list', 'agents_list'],
    ['status', 'agents_status'],
  ] as const)('prints %s JSON without importing probe/install capabilities', async (subcommand, expectedKind) => {
    seedProviderRegistry();
    const { handleAgentsCommand } = await import('./agents');
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand([subcommand, '--json']);
      const parsed = JSON.parse(output.logs.join('\n').trim());
      expect(parsed).toMatchObject({
        v: 1,
        ok: true,
        kind: expectedKind,
      });
    } finally {
      output.restore();
    }
  });
});
