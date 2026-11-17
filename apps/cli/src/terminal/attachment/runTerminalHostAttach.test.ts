import { describe, expect, it, vi } from 'vitest';

import { runTerminalHostAttach } from './runTerminalHostAttach';

describe('runTerminalHostAttach', () => {
  it('routes Zellij through the same terminal-host attachment owner as tmux and Herdr', async () => {
    const runZellijAttachFn = vi.fn(async () => 0);
    const terminal = {
      mode: 'zellij' as const,
      requested: 'zellij' as const,
      zellij: { sessionName: 'happier', paneId: '9' },
    };

    await expect(runTerminalHostAttach({ sessionId: 'session-1', terminal }, {
      runTmuxAttachFn: async () => 0,
      runZellijAttachFn,
      runHerdrAttachFn: async () => 0,
      runPtyAttachFn: async () => 0,
    })).resolves.toBe(0);
    expect(runZellijAttachFn).toHaveBeenCalledWith({ sessionId: 'session-1', terminal });
  });

  it('attaches a Holder-PTY Session through its Agent terminal, addressed by the Session', async () => {
    const runPtyAttachFn = vi.fn(async () => 0);
    const terminal = { mode: 'pty' as const, pty: { host: 'holder' as const } };
    await expect(runTerminalHostAttach({ sessionId: 'session-1', terminal }, {
      runTmuxAttachFn: async () => 1,
      runZellijAttachFn: async () => 1,
      runHerdrAttachFn: async () => 1,
      runPtyAttachFn,
    })).resolves.toBe(0);
    expect(runPtyAttachFn).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });
});
