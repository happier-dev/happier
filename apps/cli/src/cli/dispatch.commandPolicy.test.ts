import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { localTuiHandlerSpy, findCommandDispatchDescriptorSpy } = vi.hoisted(() => ({
  localTuiHandlerSpy: vi.fn(async () => {}),
  findCommandDispatchDescriptorSpy: vi.fn((command: string) => {
    if (command !== 'local-tui-provider') return null;
    return {
      id: 'local-tui-provider',
      command: 'local-tui-provider',
      handler: localTuiHandlerSpy,
      policy: {
        daemonAutostartDefault: 'preferLocalTui',
      },
    };
  }),
}));

vi.mock('@/cli/commandRegistry', () => ({
  commandRegistry: {
    'local-tui-provider': localTuiHandlerSpy,
  },
  ensureMergedAgentCommandRegistryLoaded: vi.fn(async () => {}),
  findCommandDispatchDescriptor: findCommandDispatchDescriptorSpy,
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli command policy', () => {
  let prevEnv: string | undefined;
  let prevInTty: boolean | undefined;
  let prevOutTty: boolean | undefined;

  beforeEach(() => {
    prevEnv = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    prevInTty = process.stdin.isTTY;
    prevOutTty = process.stdout.isTTY;
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    localTuiHandlerSpy.mockClear();
    findCommandDispatchDescriptorSpy.mockClear();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = prevEnv;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevInTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: prevOutTty, configurable: true });
  });

  it('honors local-TUI daemon-autostart defaults from command descriptors', async () => {
    await dispatchCli({
      args: ['local-tui-provider'],
      rawArgv: ['happier', 'local-tui-provider'],
      terminalRuntime: null,
    });

    expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
    expect(findCommandDispatchDescriptorSpy).toHaveBeenCalledWith('local-tui-provider');
    expect(localTuiHandlerSpy).toHaveBeenCalled();
  });
});
