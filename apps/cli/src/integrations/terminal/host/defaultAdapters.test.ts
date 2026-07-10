import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter } from './_types';
import { createDefaultTerminalHostAdapterInventory } from './defaultAdapters';

function adapter(kind: TerminalHostAdapter['kind']): TerminalHostAdapter {
  return {
    kind,
    createOrAttachHost: vi.fn(),
    injectUserPrompt: vi.fn(),
    interruptTurn: vi.fn(),
    evaluateLiveness: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('default terminal host adapter inventory', () => {
  it('builds one shared Unix inventory for plugin selection and daemon recovery', async () => {
    const tmux = adapter('tmux');
    const zellij = adapter('zellij');
    const createTmux = vi.fn(() => tmux);
    const createZellij = vi.fn(() => zellij);

    const result = await createDefaultTerminalHostAdapterInventory({
      happyHomeDir: '/tmp/happier',
      platform: 'linux',
      preference: 'auto',
      dependencies: {
        isTmuxAvailable: async () => true,
        resolveZellijRuntimeBinary: async () => '/managed/zellij',
        prepareZellijSocketDir: async () => undefined,
        resolveZellijSocketDir: () => '/tmp/happier/zellij',
        createTmuxTerminalHostAdapter: createTmux,
        createZellijTerminalHostAdapter: createZellij,
        createPtyTerminalHostAdapter: vi.fn(() => adapter('windows_console')),
      },
    });

    expect(result).toEqual({
      adapters: { tmux, zellij },
      tmuxAvailable: true,
      zellijAvailable: true,
    });
    expect(createTmux).toHaveBeenCalledOnce();
    expect(createZellij).toHaveBeenCalledWith({
      zellijBinary: '/managed/zellij',
      socketDir: '/tmp/happier/zellij',
    });
  });

  it('uses the Windows console adapter and skips unrequested zellij discovery on Windows', async () => {
    const windowsConsole = adapter('windows_console');
    const resolveZellijRuntimeBinary = vi.fn(async () => '/managed/zellij.exe');

    const result = await createDefaultTerminalHostAdapterInventory({
      happyHomeDir: 'C:\\happier',
      platform: 'win32',
      preference: 'auto',
      dependencies: {
        isTmuxAvailable: vi.fn(async () => true),
        resolveZellijRuntimeBinary,
        prepareZellijSocketDir: vi.fn(async () => undefined),
        resolveZellijSocketDir: vi.fn(() => 'C:\\happier\\zellij'),
        createTmuxTerminalHostAdapter: vi.fn(() => adapter('tmux')),
        createZellijTerminalHostAdapter: vi.fn(() => adapter('zellij')),
        createPtyTerminalHostAdapter: vi.fn(() => windowsConsole),
      },
    });

    expect(result).toEqual({
      adapters: { windows_console: windowsConsole },
      tmuxAvailable: false,
      zellijAvailable: false,
    });
    expect(resolveZellijRuntimeBinary).not.toHaveBeenCalled();
  });
});
