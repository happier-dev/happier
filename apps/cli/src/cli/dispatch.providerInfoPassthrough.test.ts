import { beforeEach, describe, expect, it, vi } from 'vitest';

const { geminiHandlerSpy } = vi.hoisted(() => ({
  geminiHandlerSpy: vi.fn(async () => {}),
}));
const ensureMergedAgentCommandRegistryLoadedSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    gemini: geminiHandlerSpy,
  },
  ensureMergedAgentCommandRegistryLoaded: ensureMergedAgentCommandRegistryLoadedSpy,
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
  });

  it('lets provider command handlers compose provider --help requests with Happier help', async () => {
    await dispatchCli({
      args: ['gemini', '--help'],
      rawArgv: ['happier', 'gemini', '--help'],
      terminalRuntime: null,
    });

    expect(geminiHandlerSpy).toHaveBeenCalledWith({
      args: ['gemini', '--help'],
      rawArgv: ['happier', 'gemini', '--help'],
      terminalRuntime: null,
    });
    expect(ensureMergedAgentCommandRegistryLoadedSpy).not.toHaveBeenCalled();
  });
});
