import { describe, expect, it } from 'vitest';

describe('resolveHasTTY', () => {
  it('requires both stdin/stdout TTY, allows daemon-started sessions with TTY', async () => {
    const { resolveHasTTY } = await import('./resolveHasTTY');

    // Terminal-started with TTY
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: true, startedBy: 'terminal' })).toBe(true);
    // Daemon-started with TTY but without tmux -> still disallowed
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: true, startedBy: 'daemon' })).toBe(false);
    // Daemon-started with tmux + feature flag should be allowed
    process.env.TMUX = 'tmux-1234/default,1000,0';
    process.env.HAPPIER_CLI_ALLOW_DAEMON_TTY_IN_TMUX = '1';
    try {
      expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: true, startedBy: 'daemon' })).toBe(true);
    } finally {
      delete process.env.TMUX;
      delete process.env.HAPPIER_CLI_ALLOW_DAEMON_TTY_IN_TMUX;
    }
    // Missing stdout TTY
    expect(resolveHasTTY({ stdoutIsTTY: false, stdinIsTTY: true, startedBy: 'terminal' })).toBe(false);
    // Missing stdin TTY
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: false, startedBy: 'terminal' })).toBe(false);
    // Daemon-started without TTY
    expect(resolveHasTTY({ stdoutIsTTY: false, stdinIsTTY: false, startedBy: 'daemon' })).toBe(false);
  });
});
