import { describe, expect, it } from 'vitest';

describe('resolveHasTTY', () => {
  it('requires both stdin/stdout TTY and blocks daemon-started sessions', async () => {
    const { resolveHasTTY } = await import('./resolveHasTTY');

    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: true, startedBy: 'terminal' })).toBe(true);
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: true, startedBy: 'daemon' })).toBe(false);
    expect(resolveHasTTY({ stdoutIsTTY: false, stdinIsTTY: true, startedBy: 'terminal' })).toBe(false);
    expect(resolveHasTTY({ stdoutIsTTY: true, stdinIsTTY: false, startedBy: 'terminal' })).toBe(false);
  });
});

