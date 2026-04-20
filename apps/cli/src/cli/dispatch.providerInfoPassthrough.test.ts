import { beforeEach, describe, expect, it, vi } from 'vitest';

const { geminiHandlerSpy, passthroughSpy } = vi.hoisted(() => ({
  geminiHandlerSpy: vi.fn(async () => {}),
  passthroughSpy: vi.fn(() => false),
}));
const ensureMergedAgentCommandRegistryLoadedSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    gemini: geminiHandlerSpy,
  },
  ensureMergedAgentCommandRegistryLoaded: ensureMergedAgentCommandRegistryLoadedSpy,
}));

vi.mock('@/cli/providerCliPassthrough', () => ({
  maybePassthroughProviderCliInfoRequest: passthroughSpy,
}));

vi.mock('@/backends/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/catalog')>();
  return {
    ...actual,
    resolveCatalogAgentIdForCliSubcommand: vi.fn(() => 'gemini'),
    requireCatalogEntry: vi.fn(() => ({
      getCliCommandHandler: async () => geminiHandlerSpy,
    })),
  };
});

import { dispatchCli } from './dispatch';

describe('dispatchCli provider info passthrough', () => {
  beforeEach(() => {
    geminiHandlerSpy.mockClear();
    ensureMergedAgentCommandRegistryLoadedSpy.mockClear();
    passthroughSpy.mockReset();
    passthroughSpy.mockReturnValue(false);
  });

  it('short-circuits provider --help requests before invoking the provider command handler', async () => {
    passthroughSpy.mockReturnValue(true);

    await dispatchCli({
      args: ['gemini', '--help'],
      rawArgv: ['happier', 'gemini', '--help'],
      terminalRuntime: null,
    });

    expect(passthroughSpy).toHaveBeenCalledWith({
      agentId: 'gemini',
      args: ['gemini', '--help'],
    });
    expect(geminiHandlerSpy).not.toHaveBeenCalled();
    expect(ensureMergedAgentCommandRegistryLoadedSpy).not.toHaveBeenCalled();
  });
});
