import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

const render = vi.fn(() => ({ unmount: vi.fn(), rerender: vi.fn() }));

vi.mock('ink', () => ({
  render,
}));

describe('createCodexRemoteTerminalUi', () => {
  it('starts a static remote-control surface without rendering Ink', async () => {
    const stop = vi.fn(async () => undefined);
    const startRemoteModeStaticControl = vi.fn(() => ({ stop }));
    vi.doMock('@/ui/remoteControl/remoteModeControl', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/ui/remoteControl/remoteModeControl')>();
      return {
        ...actual,
        startRemoteModeStaticControl,
      };
    });

    const { createCodexRemoteTerminalUi } = await import('./createRemoteTerminalUi');
    const ui = createCodexRemoteTerminalUi({
      messageBuffer: new MessageBuffer(),
      hasTTY: true,
      surface: 'static',
      stdin: {
        isTTY: true,
        resume: vi.fn(),
        setRawMode: vi.fn(),
        setEncoding: vi.fn(),
      } as unknown as NodeJS.ReadStream,
      stdout: {} as NodeJS.WriteStream,
      onExit: vi.fn(async () => undefined),
      onSwitchToTerminal: vi.fn(async () => undefined),
    });

    ui.mount();

    expect(startRemoteModeStaticControl).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'Codex',
      allowSwitchToTerminal: false,
    }));
    expect(render).not.toHaveBeenCalled();

    await ui.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
