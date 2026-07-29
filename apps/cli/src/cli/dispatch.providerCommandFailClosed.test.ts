import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { defaultHandlerSpy, resolveMergedContributionRegistryMock, primeResolvedContributionRegistryMock } = vi.hoisted(() => ({
  defaultHandlerSpy: vi.fn(async () => {}),
  resolveMergedContributionRegistryMock: vi.fn(async () => ({
    agents: [],
    backends: [],
    runtimeAdaptersByBackendId: new Map(),
    catalogEntriesById: {},
    agentDefinitionsById: new Map(),
    backendDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
  })),
  primeResolvedContributionRegistryMock: vi.fn(async () => {}),
}));

vi.mock('@/agent/catalog/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/catalog/registry')>();
  return {
    ...actual,
    requireCatalogEntry: vi.fn(() => ({
      getCliCommandHandler: async () => defaultHandlerSpy,
    })),
  };
});

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>();
  return {
    ...actual,
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
    primeResolvedContributionRegistry: primeResolvedContributionRegistryMock,
  };
});

import { dispatchCli } from './dispatch';

describe('dispatchCli provider namespace fail-closed behavior', () => {
  beforeEach(() => {
    defaultHandlerSpy.mockClear();
    resolveMergedContributionRegistryMock.mockClear();
    primeResolvedContributionRegistryMock.mockClear();
    process.exitCode = undefined;
  });

  it('fails closed for singular provider commands instead of starting a default session', async () => {
    for (const subcommand of ['status', 'probe']) {
      process.exitCode = undefined;
      defaultHandlerSpy.mockClear();
      resolveMergedContributionRegistryMock.mockClear();
      primeResolvedContributionRegistryMock.mockClear();

      const output = captureConsoleJsonOutput<{
        ok: boolean;
        kind: string;
        error?: { code?: string; message?: string };
      }>();
      try {
        await dispatchCli({
          args: ['provider', subcommand, 'kimi', '--json'],
          rawArgv: ['happier', 'provider', subcommand, 'kimi', '--json'],
          terminalRuntime: null,
        });
        const parsed = output.json();
        expect(parsed.ok).toBe(false);
        expect(parsed.kind).toBe('cli_dispatch');
        expect(parsed.error?.code).toBe('unknown_command');
        expect(parsed.error?.message).toEqual(expect.stringContaining('providers'));
        expect(process.exitCode).toBe(1);
      } finally {
        output.restore();
      }

      expect(defaultHandlerSpy).not.toHaveBeenCalled();
      expect(resolveMergedContributionRegistryMock).not.toHaveBeenCalled();
    }
  });
});
