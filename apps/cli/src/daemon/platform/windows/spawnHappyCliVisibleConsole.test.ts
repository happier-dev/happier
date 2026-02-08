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
  afterEach(() => {
    vi.clearAllMocks();
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
