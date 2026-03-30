import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { PtySpawnParams } from './ptyProvider';
import {
  buildPythonPtyRelaySpawnCommand,
  createPythonPtyRelayProvider,
} from './pythonPtyRelayProvider';

function createFakeChildProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const processEmitter = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  processEmitter.stdin = { write: vi.fn() };
  processEmitter.stdout = stdout;
  processEmitter.stderr = stderr;
  processEmitter.kill = vi.fn();
  return processEmitter;
}

describe('buildPythonPtyRelaySpawnCommand', () => {
  it('builds a python relay invocation that forwards the child command after --', () => {
    const invocation = buildPythonPtyRelaySpawnCommand({
      pythonExecutable: '/usr/bin/python3',
      file: '/bin/zsh',
      args: ['-l'],
    });

    expect(invocation.command).toBe('/usr/bin/python3');
    expect(invocation.args.slice(0, 3)).toEqual(['-u', '-c', expect.any(String)]);
    expect(invocation.args.slice(3)).toEqual(['--', '/bin/zsh', '-l']);
  });
});

describe('createPythonPtyRelayProvider', () => {
  it('returns null on Windows', () => {
    expect(createPythonPtyRelayProvider({ platform: 'win32', pythonExecutable: 'python3' })).toBeNull();
  });

  it('wraps the python relay child process as a PtyProcess', () => {
    const fakeChild = createFakeChildProcess();
    const spawnProcess = vi.fn(() => fakeChild as any);
    const provider = createPythonPtyRelayProvider({
      platform: 'darwin',
      pythonExecutable: '/usr/bin/python3',
      spawnProcess,
    });
    expect(provider).toBeTruthy();

    const pty = provider!.spawn({
      file: '/bin/zsh',
      args: ['-l'],
      options: { cwd: '/Users/tester', env: { PATH: '/usr/bin' } },
    } satisfies PtySpawnParams);

    const onData = vi.fn();
    const onExit = vi.fn();
    const dataDisposable = pty.onData(onData);
    const exitDisposable = pty.onExit(onExit);
    pty.write('hello');
    fakeChild.stdout.emit('data', 'out');
    fakeChild.stderr.emit('data', 'err');
    fakeChild.emit('exit', 0, null);
    pty.kill('SIGTERM');
    dataDisposable.dispose();
    exitDisposable.dispose();

    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/python3',
      ['-u', '-c', expect.any(String), '--', '/bin/zsh', '-l'],
      {
        cwd: '/Users/tester',
        env: { PATH: '/usr/bin' },
        stdio: 'pipe',
      },
    );
    expect(fakeChild.stdin.write).toHaveBeenCalledWith('hello');
    expect(onData).toHaveBeenNthCalledWith(1, 'out');
    expect(onData).toHaveBeenNthCalledWith(2, 'err');
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
