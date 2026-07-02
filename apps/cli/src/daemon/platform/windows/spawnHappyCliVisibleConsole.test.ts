import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { startHappySessionInVisibleWindowsConsole } from './spawnHappyCliVisibleConsole';

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

describe('startHappySessionInVisibleWindowsConsole', () => {
  const originalAmbientOnly = process.env.HAPPIER_VISIBLE_CONSOLE_AMBIENT_ONLY_TEST;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalAmbientOnly === undefined) {
      delete process.env.HAPPIER_VISIBLE_CONSOLE_AMBIENT_ONLY_TEST;
    } else {
      process.env.HAPPIER_VISIBLE_CONSOLE_AMBIENT_ONLY_TEST = originalAmbientOnly;
    }
  });

  it('returns pid when powershell prints it', async () => {
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = startHappySessionInVisibleWindowsConsole({
      workingDirectory: 'C:\\repo',
      env: { FOO: 'bar' },
      filePath: 'C:\\node\\node.exe',
      args: ['--version'],
    });

    child.stdout.emit('data', Buffer.from('12345\r\n'));
    child.emit('close', 0);

    await expect(p).resolves.toEqual({ ok: true, pid: 12345 });
    expect(spawn).toHaveBeenCalled();
  });

  it('uses the provided launch env as the complete PowerShell environment', async () => {
    process.env.HAPPIER_VISIBLE_CONSOLE_AMBIENT_ONLY_TEST = 'ambient-only';
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = startHappySessionInVisibleWindowsConsole({
      workingDirectory: 'C:\\repo',
      env: {
        HAPPIER_VISIBLE_CONSOLE_DAEMON_ONLY_TEST: 'daemon-only',
        HAPPIER_VISIBLE_CONSOLE_SHARED_TEST: 'daemon',
      },
      filePath: 'C:\\node\\node.exe',
      args: ['--version'],
    });

    child.stdout.emit('data', Buffer.from('12345\r\n'));
    child.emit('close', 0);

    await expect(p).resolves.toEqual({ ok: true, pid: 12345 });
    const spawnOptions = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(spawnOptions?.env).toMatchObject({
      HAPPIER_VISIBLE_CONSOLE_DAEMON_ONLY_TEST: 'daemon-only',
      HAPPIER_VISIBLE_CONSOLE_SHARED_TEST: 'daemon',
    });
    expect(spawnOptions?.env?.HAPPIER_VISIBLE_CONSOLE_AMBIENT_ONLY_TEST).toBeUndefined();
  });

  it('returns error when pid is missing', async () => {
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = startHappySessionInVisibleWindowsConsole({
      workingDirectory: 'C:\\repo',
      env: {},
      filePath: 'C:\\node\\node.exe',
      args: ['--version'],
    });

    child.stdout.emit('data', Buffer.from('nope\r\n'));
    child.emit('close', 0);

    const result = await p;
    expect(result.ok).toBe(false);
  });

  it('returns error when pid is not a positive integer', async () => {
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = startHappySessionInVisibleWindowsConsole({
      workingDirectory: 'C:\\repo',
      env: {},
      filePath: 'C:\\node\\node.exe',
      args: ['--version'],
    });

    child.stdout.emit('data', Buffer.from('0\r\n'));
    child.emit('close', 0);

    const result = await p;
    expect(result.ok).toBe(false);
  });

  it('returns error when powershell exits non-zero', async () => {
    const child = createFakeChildProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = startHappySessionInVisibleWindowsConsole({
      workingDirectory: 'C:\\repo',
      env: {},
      filePath: 'C:\\node\\node.exe',
      args: ['--version'],
    });

    child.stderr.emit('data', Buffer.from('cannot start process'));
    child.emit('close', 1);

    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain('PowerShell exit 1');
      expect(result.errorMessage).toContain('cannot start process');
    }
  });
});
