import { describe, expect, it } from 'vitest';

describe('resolveHasTTY', () => {
  it('requires both stdin/stdout TTY, allows daemon-started sessions with TTY', async () => {
    const { resolveHasTTY } = await import('./resolveHasTTY');

    // Terminal-started with TTY
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: true, startedBy: 'terminal' })).toBe(true);
    // Daemon-started with TTY (e.g., tmux) - now allowed for local resume
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: true, startedBy: 'daemon' })).toBe(true);
    // Missing stdout TTY
    expect(resolveHasTTY({ stdoutIsTTY: false, stdinIsTTY: true, startedBy: 'terminal' })).toBe(false);
    // Missing stdin TTY
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: false, startedBy: 'terminal' })).toBe(false);
    // Daemon-started without TTY
    expect(resolveHasTTY({ stdoutIsTTY: false, stdinIsTTY: false, startedBy: 'daemon' })).toBe(false);
  });
});

