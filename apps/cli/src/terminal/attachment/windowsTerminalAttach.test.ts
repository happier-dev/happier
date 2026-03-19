import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { focusWindowsTerminalWindow } from './windowsTerminalAttach';

type SpawnMockChild = EventEmitter;

function createFakeChildProcess(): SpawnMockChild {
  return new EventEmitter();
}

describe('focusWindowsTerminalWindow', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('focuses an existing Windows Terminal window by id', async () => {
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const pending = focusWindowsTerminalWindow({ windowId: 'happy-session-1' });
    child.emit('exit', 0);

    await expect(pending).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'wt.exe',
      ['-w', 'happy-session-1', 'focus-tab', '-t', '0'],
      expect.objectContaining({ shell: false }),
    );
  });
});
