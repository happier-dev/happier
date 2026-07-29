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
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createFakeChildProcess(): SpawnMockChild {
  const child = new EventEmitter() as SpawnMockChild;
  child.pid = 4242;
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

    await expect(pending).resolves.toEqual({
      ok: true,
      pid: 12345,
      custodyPid: 4242,
    });
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

    await expect(pending).resolves.toEqual({
      ok: true,
      pid: 12345,
      custodyPid: 4242,
    });
    const spawnOptions = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(spawnOptions?.env).toMatchObject({
      HAPPIER_WINDOWS_TERMINAL_DAEMON_ONLY_TEST: 'daemon-only',
      HAPPIER_WINDOWS_TERMINAL_SHARED_TEST: 'daemon',
    });
    expect(spawnOptions?.env?.HAPPIER_WINDOWS_TERMINAL_AMBIENT_ONLY_TEST).toBeUndefined();
  });

  it('classifies a PowerShell spawn error as proven pre-dispatch without exposing its message', async () => {
    const child = createFakeChildProcess();
    child.pid = undefined;
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    const pending = startHappySessionInWindowsTerminal({
      workingDirectory: 'C:\\repo',
      env: {},
      filePath: 'C:\\secret\\happier.exe',
      args: ['--token', 'never-return-this'],
      windowId: 'happy-session-1',
      title: 'Happier Session happy-session-1',
    });

    child.emit(
      'error',
      new Error('spawn failed C:\\secret\\happier.exe never-return-this'),
    );

    const result = await pending;
    expect(result).toEqual({
      ok: false,
      dispatch: 'not_started',
      errorMessage:
        'Windows Terminal dispatcher could not be started',
    });
    expect(JSON.stringify(result)).not.toContain('never-return-this');
  });

  it.each([
    ['nonzero close', (child: SpawnMockChild) => {
      child.stderr.emit('data', 'never-return-this');
      child.emit('close', 1);
    }],
    ['invalid pid output', (child: SpawnMockChild) => {
      child.stdout.emit('data', 'never-return-this');
      child.emit('close', 0);
    }],
  ])('classifies %s as dispatch-uncertain without exposing process output', async (_label, settle) => {
    const child = createFakeChildProcess();
    child.pid = 4242;
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    const pending = startHappySessionInWindowsTerminal({
      workingDirectory: 'C:\\repo',
      env: {},
      filePath: 'C:\\secret\\happier.exe',
      args: ['--token', 'never-return-this'],
      windowId: 'happy-session-1',
      title: 'Happier Session happy-session-1',
    });

    settle(child);

    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      dispatch: 'uncertain',
      custodyPid: 4242,
    });
    expect(JSON.stringify(result)).not.toContain('never-return-this');
    expect(JSON.stringify(result)).not.toContain('C:\\secret');
  });

});
