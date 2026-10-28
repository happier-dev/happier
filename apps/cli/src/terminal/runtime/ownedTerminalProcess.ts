import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { isNativeProcessExited } from '../../../scripts/native_process_exit.cjs';

import { logger } from '@/ui/logger';
import type { TerminalSpawn } from './terminalLaunchSpec';

type OwnedTerminalChild = Readonly<{
  pid?: number;
  exitCode: number | null;
  connected?: boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'disconnect', listener: () => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  send(message: unknown, callback: (error: Error | null) => void): boolean;
}>;

export type OwnedTerminalProcessIdentity = Readonly<{
  pid: number;
  processInstanceFingerprint: string;
}>;

export type OwnedTerminalProcess = Readonly<{
  /** Captured only after the real native-spawn IPC acknowledgement. Unknown is not custody. */
  launcherIdentity: OwnedTerminalProcessIdentity | null;
  whenExited: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; processTreeStopped?: boolean; nativeExited?: boolean }>>;
  terminate: () => Promise<void>;
  signal: (signal: 'SIGINT' | 'SIGKILL') => Promise<void>;
}>;

export async function launchOwnedTerminalProcess(params: Readonly<{
  spawn: TerminalSpawn;
  cwd: string;
  spawnProcess?: typeof spawn;
  terminateProcess?: (child: OwnedTerminalChild) => Promise<void | Awaited<ReturnType<typeof killProcessTree>>>;
}>): Promise<OwnedTerminalProcess> {
  const [command, ...args] = params.spawn.spawnArgv;
  if (!command) throw new Error('Owned terminal launch requires a command');

  const env = { ...params.spawn.spawnEnv };
  const invocation = resolveWindowsCommandInvocation({
    command,
    args,
    env,
    resolveCommandOnPath: false,
  });
  const spawnProcess = params.spawnProcess ?? spawn;
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd: params.cwd,
    env,
    // Only this child-owned, same-pane path binds the launcher to our lifetime. Terminal
    // streams remain inherited; the private IPC channel closes even on controller SIGKILL.
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    serialization: 'json',
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });

  let startupSettled = false;
  let resolveStartup: (() => void) | null = null;
  let rejectStartup: ((error: Error) => void) | null = null;
  const startup = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  let termination: Promise<void> | null = null;
  let processTreeStopped = false;
  let nativeExited = false;
  const channelClosed = child.connected
    ? new Promise<void>((resolve) => { child.once('disconnect', resolve); })
    : Promise.resolve();
  const whenExited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; processTreeStopped?: boolean; nativeExited?: boolean }>>((resolve, reject) => {
    child.once('error', (error) => {
      if (!startupSettled) {
        startupSettled = true;
        rejectStartup?.(error);
      }
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!startupSettled) {
        startupSettled = true;
        rejectStartup?.(new Error('Owned terminal process exited before startup completed'));
      }
      // Wrapper exit alone does not establish descendant exit after an abrupt signal.
      void Promise.all([channelClosed, Promise.resolve(termination).catch(() => undefined)]).then(() => {
        resolve({ code, signal, ...(processTreeStopped ? { processTreeStopped: true } : {}), ...(nativeExited ? { nativeExited: true } : {}) });
      });
    });
  });
  // A spawn failure rejects both startup and exit observation. Mark the latter handled before
  // awaiting startup; callers cannot receive the process handle when startup itself rejects.
  void whenExited.catch(() => undefined);
  child.on('message', (message) => {
    if (isNativeProcessExited(message)) nativeExited = true;
    if (typeof message !== 'object' || message === null || !('type' in message)) return;
    if (message.type === 'terminal-native-signal-failed') {
      logger.infoFile('[terminal] Native terminal signal could not be delivered (terminal_native_signal_failed)');
    }
    if (message.type !== 'terminal-native-spawned' || startupSettled) return;
    startupSettled = true;
    resolveStartup?.();
  });
  try {
    await startup;
  } catch (error) {
    try {
      await params.spawn.cleanupUnreadArtifacts?.();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Owned terminal startup failed with incomplete cleanup', { cause: error });
    }
    throw error;
  }

  const terminateProcess = params.terminateProcess ?? killProcessTree;
  const processInstanceFingerprint = typeof child.pid === 'number'
    ? readProcessInstanceFingerprintSync(child.pid) : null;
  const launcherIdentity = typeof child.pid === 'number' && processInstanceFingerprint
    ? { pid: child.pid, processInstanceFingerprint } : null;
  return {
    launcherIdentity,
    whenExited,
    signal: (signal) => new Promise<void>((resolve, reject) => {
      child.send({ type: 'terminal-native-signal', signal }, (error) => error ? reject(error) : resolve());
    }),
    terminate: () => {
      if (!termination) {
        const attempt = Promise.resolve().then(() => terminateProcess(child)).then((result) => {
          processTreeStopped = result?.rootObservedAlive === true;
        });
        const guardedAttempt = attempt.catch((error) => {
          if (termination === guardedAttempt) termination = null;
          throw error;
        });
        termination = guardedAttempt;
      }
      return termination;
    },
  };
}

/** One same-pane child lifetime, including an optional admitted external host association. */
export async function runOwnedTerminalProcess(params: Parameters<typeof launchOwnedTerminalProcess>[0] & Readonly<{
  onStarted?: (identity: OwnedTerminalProcessIdentity) => Promise<void>;
  onExited?: (identity: OwnedTerminalProcessIdentity) => Promise<void>;
}>): Promise<Awaited<OwnedTerminalProcess['whenExited']>> {
  const child = await launchOwnedTerminalProcess(params);
  let admitted = false;
  try {
    if (params.onStarted) {
      if (!child.launcherIdentity) throw new Error('terminal_native_client_identity_unknown');
      await params.onStarted(child.launcherIdentity);
      admitted = true;
    }
    return await child.whenExited;
  } catch (error) {
    await child.terminate();
    throw error;
  } finally {
    if (admitted && child.launcherIdentity) await params.onExited?.(child.launcherIdentity);
  }
}
