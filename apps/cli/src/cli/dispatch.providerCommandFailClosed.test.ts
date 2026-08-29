import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { defaultHandlerSpy, resolveMergedContributionRegistryMock } = vi.hoisted(() => ({
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
  };
});

import { dispatchCli } from './dispatch';

describe('dispatchCli provider compatibility alias', () => {
  beforeEach(() => {
    defaultHandlerSpy.mockClear();
    resolveMergedContributionRegistryMock.mockClear();
    process.exitCode = undefined;
  });

  it('routes singular provider invocations without starting the default Agent', async () => {
    const output = captureConsoleJsonOutput<{ ok: boolean; kind: string }>();
    try {
      await dispatchCli({
        args: ['provider', '--help', '--json'],
        rawArgv: ['happier', 'provider', '--help', '--json'],
        terminalRuntime: null,
      });
      expect(output.json()).toMatchObject({ ok: true, kind: 'providers_help' });
    } finally {
      output.restore();
    }

    expect(defaultHandlerSpy).not.toHaveBeenCalled();
    expect(resolveMergedContributionRegistryMock).not.toHaveBeenCalled();
  });
});
