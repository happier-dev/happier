import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { startHappySessionInWindowsTerminal } from './spawnHappyCliWindowsTerminal';

type SpawnMockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createFakeChildProcess(): SpawnMockChild {
  const child = new EventEmitter() as SpawnMockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('startHappySessionInWindowsTerminal', () => {
  const originalAmbientOnly = process.env.HAPPIER_WINDOWS_TERMINAL_AMBIENT_ONLY_TEST;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalAmbientOnly === undefined) {
      delete process.env.HAPPIER_WINDOWS_TERMINAL_AMBIENT_ONLY_TEST;
    } else {
      process.env.HAPPIER_WINDOWS_TERMINAL_AMBIENT_ONLY_TEST = originalAmbientOnly;
    }
  });

  it('returns pid when powershell prints it', async () => {
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const pending = startHappySessionInWindowsTerminal({
      workingDirectory: 'C:\\repo',
      env: { FOO: 'bar' },
      filePath: 'C:\\node\\node.exe',
      args: ['--version'],
      windowId: 'happy-session-1',
      title: 'Happier Session happy-session-1',
    });

    child.stdout.emit('data', Buffer.from('12345\r\n'));
    child.emit('close', 0);

    await expect(pending).resolves.toEqual({ ok: true, pid: 12345 });
    expect(spawn).toHaveBeenCalled();
  });

  it('uses the provided launch env as the complete PowerShell environment', async () => {
    process.env.HAPPIER_WINDOWS_TERMINAL_AMBIENT_ONLY_TEST = 'ambient-only';
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const pending = startHappySessionInWindowsTerminal({
      workingDirectory: 'C:\\repo',
      env: {
        HAPPIER_WINDOWS_TERMINAL_DAEMON_ONLY_TEST: 'daemon-only',
        HAPPIER_WINDOWS_TERMINAL_SHARED_TEST: 'daemon',
      },
      filePath: 'C:\\node\\node.exe',
      args: ['--version'],
      windowId: 'happy-session-1',
      title: 'Happier Session happy-session-1',
    });

    child.stdout.emit('data', Buffer.from('12345\r\n'));
    child.emit('close', 0);

    await expect(pending).resolves.toEqual({ ok: true, pid: 12345 });
    const spawnOptions = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(spawnOptions?.env).toMatchObject({
      HAPPIER_WINDOWS_TERMINAL_DAEMON_ONLY_TEST: 'daemon-only',
      HAPPIER_WINDOWS_TERMINAL_SHARED_TEST: 'daemon',
    });
    expect(spawnOptions?.env?.HAPPIER_WINDOWS_TERMINAL_AMBIENT_ONLY_TEST).toBeUndefined();
  });
});
