import { describe, expect, it, vi } from 'vitest';

import { runTerminalRemoteSessionModeLoop } from './runTerminalRemoteSessionModeLoop';

describe('runTerminalRemoteSessionModeLoop', () => {
  it('returns the terminal exit code without entering remote mode', async () => {
    const onModeChange = vi.fn();

    await expect(runTerminalRemoteSessionModeLoop({
      remoteExitCode: 0,
      onModeChange,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 42 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
    })).resolves.toBe(42);

    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('owns terminal remote switching and terminal re-entry state', async () => {
    const entries: string[] = [];
    const modes: string[] = [];
    const runRemote = vi.fn()
      .mockResolvedValueOnce('switch')
      .mockResolvedValueOnce('exit');
    const runTerminal = vi.fn(async (params: { entry: 'initial' | 'switch' }) => {
      entries.push(params.entry);
      return entries.length === 1
        ? { type: 'switch' } as const
        : { type: 'exit', code: 7 } as const;
    });

    await expect(runTerminalRemoteSessionModeLoop({
      remoteExitCode: 0,
      onModeChange: (mode) => {
        modes.push(mode);
      },
      runTerminal,
      runRemote,
    })).resolves.toBe(7);

    expect(entries).toEqual(['initial', 'switch']);
    expect(modes).toEqual(['remote', 'terminal']);
    expect(runRemote).toHaveBeenCalledTimes(1);
  });

  it('starts remote-first sessions with switch entry when returning to terminal mode', async () => {
    const entries: string[] = [];
    const modes: string[] = [];

    await expect(runTerminalRemoteSessionModeLoop({
      startingMode: 'remote',
      remoteExitCode: 0,
      onModeChange: (mode) => {
        modes.push(mode);
      },
      runRemote: vi.fn(async () => 'switch' as const),
      runTerminal: vi.fn(async (params: { entry: 'initial' | 'switch' }) => {
        entries.push(params.entry);
        return { type: 'exit', code: 3 } as const;
      }),
    })).resolves.toBe(3);

    expect(entries).toEqual(['switch']);
    expect(modes).toEqual(['terminal']);
  });
});
