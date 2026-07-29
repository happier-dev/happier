import { Buffer } from 'node:buffer';
import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';

import { createUtf8StreamDecoder } from './decode';
import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from './provider';

type PythonSpawnProcess = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: 'pipe';
  }>,
) => ChildProcessWithoutNullStreams;

const relayKillFallbackMs = 2_000;

const PYTHON_PTY_RELAY_SOURCE = String.raw`
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios

argv = sys.argv[1:]
if argv and argv[0] == '--':
    argv = argv[1:]
if not argv:
    raise SystemExit(64)

def _read_dimension_env(name):
    raw = os.environ.get(name, '')
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 1 else None

master_fd, slave_fd = pty.openpty()

def _apply_initial_window_size():
    cols = _read_dimension_env('HAPPIER_PYTHON_PTY_RELAY_COLS')
    rows = _read_dimension_env('HAPPIER_PYTHON_PTY_RELAY_ROWS')
    if cols is None and rows is None:
        return
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows or 24, cols or 80, 0, 0))
    except OSError:
        pass

_apply_initial_window_size()

def _configure_child_terminal():
    os.setsid()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except OSError:
        pass
    try:
        os.tcsetpgrp(slave_fd, os.getpgrp())
    except OSError:
        pass

child = subprocess.Popen(argv, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True, preexec_fn=_configure_child_terminal)
os.close(slave_fd)

def _forward(sig, _frame):
    try:
        child.send_signal(sig)
    except ProcessLookupError:
        pass

for maybe_sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(maybe_sig, _forward)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()

def _write_all(fd, data):
    offset = 0
    while offset < len(data):
        try:
            written = os.write(fd, data[offset:])
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError('short write')
        offset += written

def _terminate_child():
    if child.poll() is None:
        try:
            child.terminate()
        except ProcessLookupError:
            pass

while True:
    watched = [master_fd]
    if child.poll() is None:
        watched.append(stdin_fd)
    readable, _, _ = select.select(watched, [], [], 0.05)

    if master_fd in readable:
        try:
            data = os.read(master_fd, 65536)
        except OSError:
            data = b''
        if data:
            _write_all(stdout_fd, data)
        elif child.poll() is not None:
            break

    if stdin_fd in readable:
        try:
            data = os.read(stdin_fd, 65536)
        except OSError:
            data = b''
        if not data:
            _terminate_child()
            break
        _write_all(master_fd, data)

    if child.poll() is not None and master_fd not in readable:
        try:
            while True:
                data = os.read(master_fd, 65536)
                if not data:
                    break
                _write_all(stdout_fd, data)
        except OSError:
            pass
        break

try:
    raise SystemExit(child.wait(timeout=2))
except subprocess.TimeoutExpired:
    try:
        child.kill()
    except ProcessLookupError:
        pass
    raise SystemExit(child.wait())
`.trim();

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = normalizeNonEmptyString(env.PATH);
  if (!pathValue) return null;
  for (const segment of pathValue.split(delimiter)) {
    const baseDir = segment.trim();
    if (!baseDir) continue;
    const candidate = join(baseDir, command);
    if (canExecute(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeArgs(args: string[] | string): string[] {
  return Array.isArray(args) ? [...args] : [String(args)];
}

function normalizeDimensionEnvValue(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 1
    ? String(Math.trunc(value))
    : undefined;
}

function buildPythonRelayEnv(params: Readonly<{
  baseEnv?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(params.baseEnv ?? {}) };
  const cols = normalizeDimensionEnvValue(params.cols);
  const rows = normalizeDimensionEnvValue(params.rows);
  if (cols !== undefined) env.HAPPIER_PYTHON_PTY_RELAY_COLS = cols;
  if (rows !== undefined) env.HAPPIER_PYTHON_PTY_RELAY_ROWS = rows;
  return env;
}

function isRelayInputClosed(child: ChildProcessWithoutNullStreams, relayInputClosed: boolean): boolean {
  const stdin = child.stdin;
  return relayInputClosed ||
    stdin.destroyed === true ||
    stdin.writableEnded === true;
}

function assertRelayInputWritable(child: ChildProcessWithoutNullStreams, relayInputClosed: boolean): void {
  if (isRelayInputClosed(child, relayInputClosed)) {
    throw new Error('terminal_pty_input_closed');
  }
}

function childToPtyProcess(child: ChildProcessWithoutNullStreams): PtyProcess {
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let completedExit: PtyExitEvent | null = null;
  let relayInputClosed = false;
  let killFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const emitExit = (event: PtyExitEvent) => {
    if (completedExit) return;
    completedExit = event;
    if (killFallbackTimer) {
      clearTimeout(killFallbackTimer);
      killFallbackTimer = null;
    }
    for (const listener of exitListeners) {
      listener(event);
    }
  };

  const killRelayProcess = (signal?: string) => {
    if (typeof signal === 'string' && signal.length > 0) {
      child.kill(signal as NodeJS.Signals);
      return;
    }
    child.kill();
  };

  const requestRelayTermination = (signal?: string) => {
    relayInputClosed = true;
    if (child.stdin.destroyed === true || child.stdin.writableEnded === true) {
      killRelayProcess(signal);
      return;
    }
    try {
      child.stdin.end();
    } catch {
      killRelayProcess(signal);
      return;
    }
    if (!killFallbackTimer) {
      killFallbackTimer = setTimeout(() => {
        if (!completedExit) {
          child.kill('SIGKILL');
        }
      }, relayKillFallbackMs);
      killFallbackTimer.unref?.();
    }
  };

  child.once('error', () => {
    emitExit({ exitCode: -1 });
  });
  child.once('exit', () => {
    relayInputClosed = true;
  });
  child.stdin.on('error', () => {
    relayInputClosed = true;
  });
  child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
    const numericSignal = typeof signal === 'string' ? null : signal;
    emitExit({
      exitCode: typeof exitCode === 'number' ? exitCode : -1,
      ...(typeof numericSignal === 'number' ? { signal: numericSignal } : {}),
    } satisfies PtyExitEvent);
  });

  return {
    pid: typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0 ? child.pid : 0,
    write: (data) => {
      assertRelayInputWritable(child, relayInputClosed);
      child.stdin.write(data);
    },
    resize: () => {
      throw new Error('terminal_resize_unavailable');
    },
    kill: requestRelayTermination,
    onData: (listener) => {
      const stdoutDecoder = createUtf8StreamDecoder();
      const stderrDecoder = createUtf8StreamDecoder();
      const onStdout = (chunk: string | Buffer) => {
        const decoded = stdoutDecoder.decode(chunk);
        if (decoded) listener(decoded);
      };
      const onStderr = (chunk: string | Buffer) => {
        const decoded = stderrDecoder.decode(chunk);
        if (decoded) listener(decoded);
      };
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      return {
        dispose: () => {
          child.stdout.off('data', onStdout);
          child.stderr.off('data', onStderr);
        },
      } satisfies Disposable;
    },
    onDataBytes: (listener) => {
      const onStdout = (chunk: string | Buffer) => listener(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      const onStderr = (chunk: string | Buffer) => listener(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      return {
        dispose: () => {
          child.stdout.off('data', onStdout);
          child.stderr.off('data', onStderr);
        },
      } satisfies Disposable;
    },
    onExit: (listener) => {
      if (completedExit) {
        listener(completedExit);
        return { dispose: () => {} } satisfies Disposable;
      }
      exitListeners.add(listener);
      return {
        dispose: () => {
          exitListeners.delete(listener);
        },
      } satisfies Disposable;
    },
  };
}

export function buildPythonPtyRelaySpawnCommand(params: Readonly<{
  pythonExecutable: string;
  file: string;
  args: string[] | string;
}>): Readonly<{ command: string; args: readonly string[] }> {
  return {
    command: params.pythonExecutable,
    args: ['-u', '-c', PYTHON_PTY_RELAY_SOURCE, '--', params.file, ...normalizeArgs(params.args)],
  };
}

export function resolvePythonPtyRelayExecutable(params?: Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  explicitExecutable?: string | null;
}>): string | null {
  const platform = params?.platform ?? process.platform;
  if (platform === 'win32') return null;

  const explicitExecutable = normalizeNonEmptyString(params?.explicitExecutable)
    ?? normalizeNonEmptyString(params?.env?.HAPPIER_DAEMON_TERMINAL_PYTHON);
  if (explicitExecutable) {
    return explicitExecutable;
  }

  const env = params?.env ?? process.env;
  return resolveCommandOnPath('python3', env) ?? resolveCommandOnPath('python', env);
}

export function createPythonPtyRelayProvider(params?: Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pythonExecutable?: string | null;
  spawnProcess?: PythonSpawnProcess;
}>): PtyProvider | null {
  const platform = params?.platform ?? process.platform;
  const pythonExecutable = resolvePythonPtyRelayExecutable({
    env: params?.env ?? process.env,
    platform,
    explicitExecutable: params?.pythonExecutable,
  });
  if (!pythonExecutable) return null;

  const spawnProcess = params?.spawnProcess ?? ((command, args, options) =>
    spawnChildProcess(command, [...args], options));

  return {
    spawn: (spawnParams: PtySpawnParams) => {
      const invocation = buildPythonPtyRelaySpawnCommand({
        pythonExecutable,
        file: spawnParams.file,
        args: spawnParams.args,
      });
      const child = spawnProcess(invocation.command, invocation.args, {
        cwd: spawnParams.options.cwd,
        env: buildPythonRelayEnv({
          baseEnv: spawnParams.options.env ?? params?.env ?? process.env,
          cols: spawnParams.options.cols,
          rows: spawnParams.options.rows,
        }),
        stdio: 'pipe',
      });
      return childToPtyProcess(child);
    },
  };
}
