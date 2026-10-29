import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { createProcessTreeStopper, terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { logger } from '@/ui/logger';
import { createTerminalLaunchSpec, discardFailedTerminalLaunch } from './launchSpec';
import { isNativeProcessExited } from '../../../scripts/native_process_exit.cjs';

/** The terminal owner always supplies explicit argv and options at its OS boundary. */
export type TerminalSpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type BorrowedTerminalProcessIdentity = Readonly<{
  pid: number;
  processInstanceFingerprint: string;
}>;

export type BorrowedTerminalProcess = Readonly<{
  /** The native-spawn receipt admits the launcher; unknown process generation is not custody. */
  launcherIdentity: BorrowedTerminalProcessIdentity | null;
  whenExited: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; nativeExited?: true }>>;
  terminate(): Promise<void>;
  signal(signal: 'SIGINT' | 'SIGKILL'): Promise<void>;
}>;

export async function launchBorrowedTerminalProcess(params: Readonly<{
  spawnArgv: readonly string[];
  workingDirectory: string;
  spawnEnv: Readonly<Record<string, string>>;
  spawnProcess?: TerminalSpawnProcess;
  terminateProcess?: (child: ChildProcess) => Promise<void>;
  signal?: AbortSignal;
  envPassthroughKeys?: readonly string[];
  windowsVerbatimArguments?: boolean;
  beforeSpawn?: () => void | Promise<void>;
}>): Promise<BorrowedTerminalProcess> {
  const [command, ...args] = params.spawnArgv;
  if (!command) throw new Error('Borrowed terminal launch requires a command');
  params.signal?.throwIfAborted();

  const env = { ...params.spawnEnv };
  const invocation = resolveWindowsCommandInvocation({ command, args, env, resolveCommandOnPath: false });
  const launch = await createTerminalLaunchSpec({
    workingDirectory: params.workingDirectory,
    spawnArgv: [invocation.command, ...invocation.args],
    spawnEnv: env,
    envPassthroughKeys: params.envPassthroughKeys ?? ['TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'],
    windowsVerbatimArguments: params.windowsVerbatimArguments ?? invocation.windowsVerbatimArguments,
  });
  const launcherInvocation = resolveWindowsCommandInvocation({
    command: launch.argv[0]!, args: launch.argv.slice(1), env, resolveCommandOnPath: false,
  });
  let child: ChildProcess;
  try {
    params.signal?.throwIfAborted();
    if (params.beforeSpawn) await params.beforeSpawn();
    params.signal?.throwIfAborted();
    child = (params.spawnProcess ?? spawn)(launcherInvocation.command, launcherInvocation.args, {
      cwd: params.workingDirectory,
      env,
      // Child-owned same-pane launches end with their controller; independent hosts
      // use their adapter path and do not receive this lifetime channel.
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
      windowsHide: true,
      ...(launcherInvocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    return discardFailedTerminalLaunch(launch, error);
  }

  let startupSettled = false;
  let resolveStartup: (() => void) | null = null;
  let rejectStartup: ((error: Error) => void) | null = null;
  const startup = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  let stopProcess: ReturnType<typeof createProcessTreeStopper> | undefined;
  let exited = false;
  let nativeExited = false;
  const channelClosed = child.connected
    ? new Promise<void>(resolve => { child.once('disconnect', resolve); })
    : Promise.resolve();
  const cancelStartup = () => {
    if (startupSettled) return;
    try { child.disconnect(); }
    catch {
      logger.infoFile('[borrowed-terminal] Startup cancellation could not close the lifetime channel', {
        code: 'terminal_child_cancellation_failed',
      });
    }
  };
  params.signal?.addEventListener('abort', cancelStartup, { once: true });
  child.on('message', (message) => {
    if (isNativeProcessExited(message)) nativeExited = true;
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'terminal-native-spawned' && !startupSettled) {
      startupSettled = true;
      resolveStartup?.();
    } else if (message.type === 'terminal-native-signal-failed') {
      logger.infoFile('[borrowed-terminal] Native terminal process signal failed', {
        code: 'terminal_child_signal_failed',
      });
    }
  });
  const whenExited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; nativeExited?: true }>>((resolve, reject) => {
    child.once('error', (error) => {
      exited = true;
      if (!startupSettled) {
        startupSettled = true;
        rejectStartup?.(error);
      }
      reject(error);
    });
    child.once('exit', (code, signal) => {
      exited = true;
      if (!startupSettled) {
        startupSettled = true;
        rejectStartup?.(new Error('Borrowed terminal process exited before startup completed'));
      }
      // The private IPC channel can still be delivering the child's qualified
      // closure proof when the wrapper exits. Terminal output EOF is not custody.
      void Promise.all([channelClosed, Promise.resolve(stopProcess?.currentAttempt).catch(() => undefined)]).then(() => {
        resolve({ code, signal, ...(nativeExited ? { nativeExited: true as const } : {}) });
      });
    });
  }).finally(launch.discard);
  void whenExited.catch(() => undefined);
  if (params.signal?.aborted) cancelStartup();
  try { await startup; }
  catch (error) { return discardFailedTerminalLaunch(launch, error); }
  finally { params.signal?.removeEventListener('abort', cancelStartup); }
  // Startup failures are returned to their caller. Later completion/cleanup failures
  // need a file-only diagnostic because lifecycle readers may track only completion.
  void whenExited.catch(() => {
    logger.infoFile('[borrowed-terminal] Owned terminal process completion failed', {
      code: 'terminal_child_completion_failed',
    });
  });

  const terminateProcess = params.terminateProcess
    ?? (async (target: ChildProcess) => await terminateProcessTree(target));
  const ownedStopProcess = createProcessTreeStopper(() => terminateProcess(child));
  stopProcess = ownedStopProcess;
  const processInstanceFingerprint = typeof child.pid === 'number'
    ? readProcessInstanceFingerprintSync(child.pid)
    : null;
  return Object.freeze({
    launcherIdentity: typeof child.pid === 'number' && processInstanceFingerprint
      ? Object.freeze({ pid: child.pid, processInstanceFingerprint })
      : null,
    whenExited,
    signal: async (signal: 'SIGINT' | 'SIGKILL') => {
      if (exited) return;
      await new Promise<void>((resolve, reject) => {
        child.send({ type: 'terminal-native-signal', signal }, (error) => error ? reject(error) : resolve());
      });
    },
    terminate: ownedStopProcess.stop,
  });
}
