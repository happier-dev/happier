import { beforeEach, describe, expect, it, vi } from 'vitest';

const { uninstallHandlerSpy, defaultHandlerSpy } = vi.hoisted(() => ({
  uninstallHandlerSpy: vi.fn(async () => {}),
  defaultHandlerSpy: vi.fn(async () => {}),
}));

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    uninstall: uninstallHandlerSpy,
  },
}));

vi.mock('@/backends/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/catalog')>();
  return {
    ...actual,
    requireCatalogEntry: vi.fn(() => ({
      getCliCommandHandler: async () => defaultHandlerSpy,
    })),
  };
});

import { dispatchCli } from './dispatch';

describe('dispatchCli uninstall command', () => {
  beforeEach(() => {
    uninstallHandlerSpy.mockClear();
    defaultHandlerSpy.mockClear();
  });

  it('routes happier uninstall through the explicit command handler and does not fall through', async () => {
    await dispatchCli({
      args: ['uninstall', '--json'],
      rawArgv: ['happier', 'uninstall', '--json'],
      terminalRuntime: null,
    });

    expect(uninstallHandlerSpy).toHaveBeenCalledWith({
      args: ['uninstall', '--json'],
      rawArgv: ['happier', 'uninstall', '--json'],
      terminalRuntime: null,
    });
    expect(defaultHandlerSpy).not.toHaveBeenCalled();
  });
});
