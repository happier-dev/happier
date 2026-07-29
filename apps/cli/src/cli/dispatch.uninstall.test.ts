import { beforeEach, describe, expect, it, vi } from 'vitest';

const { uninstallHandlerSpy, defaultHandlerSpy } = vi.hoisted(() => ({
  uninstallHandlerSpy: vi.fn(async () => {}),
  defaultHandlerSpy: vi.fn(async () => {}),
}));
const ensureMergedAgentCommandRegistryLoadedSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    uninstall: uninstallHandlerSpy,
  },
  ensureMergedAgentCommandRegistryLoaded: ensureMergedAgentCommandRegistryLoadedSpy,
  resolvePluginCommandTmuxMode: vi.fn(() => null),
  findCommandDispatchDescriptor: vi.fn((command: string) => {
    if (command !== 'uninstall') return null;
    return {
      id: 'uninstall',
      command: 'uninstall',
      handler: uninstallHandlerSpy,
    };
  }),
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

import { dispatchCli } from './dispatch';

describe('dispatchCli uninstall command', () => {
  beforeEach(() => {
    uninstallHandlerSpy.mockClear();
    defaultHandlerSpy.mockClear();
    ensureMergedAgentCommandRegistryLoadedSpy.mockClear();
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
    expect(ensureMergedAgentCommandRegistryLoadedSpy).not.toHaveBeenCalled();
  });
});
