import { EventEmitter } from 'node:events';
import { spawn as spawnChildProcess } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { PtySpawnParams } from './ptyProvider';
import {
  buildPythonPtyRelaySpawnCommand,
  createPythonPtyRelayProvider,
  resolvePythonPtyRelayExecutable,
} from './pythonPtyRelayProvider';

function createFakeChildProcess(): ChildProcessWithoutNullStreams {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const processEmitter = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & {
      destroyed?: boolean;
      writableEnded?: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  processEmitter.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(function end(this: EventEmitter & { writableEnded?: boolean }) {
      this.writableEnded = true;
      return this;
    }),
  });
  processEmitter.stdout = stdout;
  processEmitter.stderr = stderr;
  processEmitter.kill = vi.fn();
  return processEmitter as unknown as ChildProcessWithoutNullStreams;
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

  it('writes PTY and pipe buffers with retry loops for partial POSIX writes', () => {
    const invocation = buildPythonPtyRelaySpawnCommand({
      pythonExecutable: '/usr/bin/python3',
      file: '/bin/zsh',
      args: ['-l'],
    });
    const relaySource = String(invocation.args[2]);

    expect(relaySource).toContain('def _write_all');
    expect(relaySource).toContain('_write_all(stdout_fd, data)');
    expect(relaySource).toContain('_write_all(master_fd, data)');
  });

  const pythonExecutable = resolvePythonPtyRelayExecutable({
    platform: process.platform,
    env: process.env,
  });
  const itIfPythonRelayCanRun = pythonExecutable ? it : it.skip;

  itIfPythonRelayCanRun('terminates the child process when relay stdin closes', async () => {
    const invocation = buildPythonPtyRelaySpawnCommand({
      pythonExecutable: pythonExecutable!,
      file: pythonExecutable!,
      args: ['-c', 'import time; time.sleep(60)'],
    });
    const child = spawnChildProcess(invocation.command, [...invocation.args], { stdio: 'pipe' });
    const timeout = Symbol('timeout');
    const closePromise = new Promise<unknown>((resolve) => {
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      child.once('error', resolve);
    });

    child.stdin.end();

    try {
      await expect(Promise.race([
        closePromise,
        new Promise((resolve) => setTimeout(() => resolve(timeout), 1_500)),
      ])).resolves.not.toBe(timeout);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 5_000);

  itIfPythonRelayCanRun('creates a controlling terminal for the child process', async () => {
    const childScript = [
      'import os, sys',
      'try:',
      '    ok = os.isatty(0) and os.tcgetpgrp(0) == os.getpgrp()',
      'except OSError:',
      '    ok = False',
      'sys.stdout.write("controlling=" + ("yes" if ok else "no"))',
    ].join('\n');
    const invocation = buildPythonPtyRelaySpawnCommand({
      pythonExecutable: pythonExecutable!,
      file: pythonExecutable!,
      args: ['-c', childScript],
    });
    const child = spawnChildProcess(invocation.command, [...invocation.args], { stdio: 'pipe' });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: string | Buffer) => {
      output.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    });
    const timeout = Symbol('timeout');
    const closePromise = new Promise<unknown>((resolve) => {
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      child.once('error', resolve);
    });

    try {
      await expect(Promise.race([
        closePromise,
        new Promise((resolve) => setTimeout(() => resolve(timeout), 1_500)),
      ])).resolves.not.toBe(timeout);
      expect(Buffer.concat(output).toString('utf8')).toContain('controlling=yes');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 5_000);
});

describe('createPythonPtyRelayProvider', () => {
  const pythonExecutable = resolvePythonPtyRelayExecutable();

  it.skipIf(!pythonExecutable).each([
    { name: 'xterm-256color', inheritedTerm: undefined, expectedTerm: 'xterm-256color' },
    { name: 'vt100', inheritedTerm: 'dumb', expectedTerm: 'vt100' },
    { name: undefined, inheritedTerm: 'vt100', expectedTerm: 'vt100' },
  ])('exposes TERM=$expectedTerm to the child with PTY name $name and inherited TERM=$inheritedTerm', async ({
    name, inheritedTerm, expectedTerm,
  }) => {
    const provider = createPythonPtyRelayProvider({ pythonExecutable })!;
    const pty = provider.spawn({
      file: pythonExecutable!,
      args: ['-c', 'import os; print(os.environ.get("TERM", "<unset>"))'],
      options: { name, env: { TERM: inheritedTerm } },
    });

    let output = '';
    pty.onData((data) => { output += data; });
    try {
      await expect.poll(() => output.trim()).toBe(expectedTerm);
    } finally {
      pty.kill();
    }
  });

  it('returns null on Windows', () => {
    expect(createPythonPtyRelayProvider({ platform: 'win32', pythonExecutable: 'python3' })).toBeNull();
  });

  it('wraps the python relay child process as a PtyProcess', () => {
    const fakeChild = createFakeChildProcess();
    const spawnProcess = vi.fn(() => fakeChild);
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
    fakeChild.stdout.emit('data', 'tail');
    expect(onExit).not.toHaveBeenCalled();
    fakeChild.emit('close', 0, null);
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
    expect(onData).toHaveBeenNthCalledWith(3, 'tail');
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it('propagates requested PTY dimensions to the relay environment', () => {
    const fakeChild = createFakeChildProcess();
    const spawnProcess = vi.fn(() => fakeChild);
    const provider = createPythonPtyRelayProvider({
      platform: 'darwin',
      pythonExecutable: '/usr/bin/python3',
      spawnProcess,
    });
    expect(provider).toBeTruthy();

    provider!.spawn({
      file: '/bin/zsh',
      args: ['-l'],
      options: {
        cwd: '/Users/tester',
        env: { PATH: '/usr/bin' },
        cols: 132,
        rows: 48,
      },
    } satisfies PtySpawnParams);

    expect(spawnProcess).toHaveBeenCalledWith(
      '/usr/bin/python3',
      ['-u', '-c', expect.any(String), '--', '/bin/zsh', '-l'],
      {
        cwd: '/Users/tester',
        env: {
          PATH: '/usr/bin',
          HAPPIER_PYTHON_PTY_RELAY_COLS: '132',
          HAPPIER_PYTHON_PTY_RELAY_ROWS: '48',
        },
        stdio: 'pipe',
      },
    );
  });

  it('fails closed for writes after relay exit and stdin stream errors', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createPythonPtyRelayProvider({
      platform: 'darwin',
      pythonExecutable: '/usr/bin/python3',
      spawnProcess: vi.fn(() => fakeChild),
    });
    expect(provider).toBeTruthy();

    const pty = provider!.spawn({
      file: '/bin/zsh',
      args: ['-l'],
      options: { cwd: '/Users/tester', env: { PATH: '/usr/bin' } },
    } satisfies PtySpawnParams);
    const onExit = vi.fn();
    pty.onExit(onExit);

    fakeChild.emit('exit', 0, null);

    expect(onExit).not.toHaveBeenCalled();
    expect(() => pty.write('after exit before close')).toThrow('terminal_pty_input_closed');
    expect(() => fakeChild.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(() => pty.write('after input error')).toThrow('terminal_pty_input_closed');
  });

  it('closes relay stdin before falling back to killing the relay process', () => {
    const fakeChild = createFakeChildProcess();
    const provider = createPythonPtyRelayProvider({
      platform: 'darwin',
      pythonExecutable: '/usr/bin/python3',
      spawnProcess: vi.fn(() => fakeChild),
    });
    expect(provider).toBeTruthy();

    const pty = provider!.spawn({
      file: '/bin/zsh',
      args: ['-l'],
      options: { cwd: '/Users/tester', env: { PATH: '/usr/bin' } },
    } satisfies PtySpawnParams);

    pty.kill();

    expect(fakeChild.stdin.end).toHaveBeenCalledOnce();
    expect(fakeChild.kill).not.toHaveBeenCalled();
    expect(() => pty.write('after kill requested')).toThrow('terminal_pty_input_closed');
  });

  it('escalates relay termination with SIGKILL when stdin EOF does not close the relay', () => {
    vi.useFakeTimers();
    try {
      const fakeChild = createFakeChildProcess();
      const provider = createPythonPtyRelayProvider({
        platform: 'darwin',
        pythonExecutable: '/usr/bin/python3',
        spawnProcess: vi.fn(() => fakeChild),
      });
      expect(provider).toBeTruthy();

      const pty = provider!.spawn({
        file: '/bin/zsh',
        args: ['-l'],
        options: { cwd: '/Users/tester', env: { PATH: '/usr/bin' } },
      } satisfies PtySpawnParams);

      pty.kill();
      vi.advanceTimersByTime(2_000);

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});
