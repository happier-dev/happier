import { beforeEach, describe, expect, it, vi } from 'vitest';

const { geminiHandlerSpy, passthroughSpy } = vi.hoisted(() => ({
  geminiHandlerSpy: vi.fn(async () => {}),
  passthroughSpy: vi.fn(() => false),
}));

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    gemini: geminiHandlerSpy,
  },
}));

vi.mock('@/cli/providerCliPassthrough', () => ({
  maybePassthroughProviderCliInfoRequest: passthroughSpy,
}));

vi.mock('@/backends/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/catalog')>();
  return {
    ...actual,
    requireCatalogEntry: vi.fn(() => ({
      getCliCommandHandler: async () => geminiHandlerSpy,
    })),
  };
});

import { dispatchCli } from './dispatch';

describe('dispatchCli provider info passthrough', () => {
  beforeEach(() => {
    geminiHandlerSpy.mockClear();
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
  });
});
