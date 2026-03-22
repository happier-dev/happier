import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from './ptyProvider';

type PythonSpawnProcess = typeof spawnChildProcess;

const PYTHON_PTY_RELAY_SOURCE = String.raw`
import os, pty, select, signal, subprocess, sys

argv = sys.argv[1:]
if argv and argv[0] == '--':
    argv = argv[1:]
if not argv:
    raise SystemExit(64)

master_fd, slave_fd = pty.openpty()
child = subprocess.Popen(argv, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True)
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
            os.write(stdout_fd, data)
        elif child.poll() is not None:
            break

    if stdin_fd in readable:
        try:
            data = os.read(stdin_fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(master_fd, data)

    if child.poll() is not None and master_fd not in readable:
        try:
            while True:
                data = os.read(master_fd, 65536)
                if not data:
                    break
                os.write(stdout_fd, data)
        except OSError:
            pass
        break

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

function childToPtyProcess(child: ChildProcessWithoutNullStreams): PtyProcess {
  return {
    write: (data) => {
      child.stdin.write(data);
    },
    resize: () => {
      // Resize forwarding is not yet implemented for the Python relay fallback.
    },
    kill: (signal) => {
      if (typeof signal === 'string' && signal.length > 0) {
        child.kill(signal as NodeJS.Signals);
        return;
      }
      child.kill();
    },
    onData: (listener) => {
      const onStdout = (chunk: string | Buffer) => listener(String(chunk));
      const onStderr = (chunk: string | Buffer) => listener(String(chunk));
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
      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        const numericSignal = typeof signal === 'string' ? null : signal;
        listener({
          exitCode: typeof exitCode === 'number' ? exitCode : -1,
          ...(typeof numericSignal === 'number' ? { signal: numericSignal } : {}),
        } satisfies PtyExitEvent);
      };
      child.on('exit', onExit);
      return {
        dispose: () => {
          child.off('exit', onExit);
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

  const spawnProcess = params?.spawnProcess ?? spawnChildProcess;

  return {
    spawn: (spawnParams: PtySpawnParams) => {
      const invocation = buildPythonPtyRelaySpawnCommand({
        pythonExecutable,
        file: spawnParams.file,
        args: spawnParams.args,
      });
      const child = spawnProcess(invocation.command, invocation.args, {
        cwd: spawnParams.options.cwd,
        env: spawnParams.options.env,
        stdio: 'pipe',
      });
      return childToPtyProcess(child);
    },
  };
}
