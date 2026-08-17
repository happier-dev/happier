import { spawn } from 'node:child_process';

import { buildWindowsCmdShimInvocation } from '../../workspaces/execYarnCommand.mjs';
import { terminateProcessTreeByPid } from './processTree.mjs';

/**
 * Shape a managed child's spawn so it always starts from argv.
 *
 * `shell: true` makes Node concatenate the command and arguments into a single
 * unescaped command line (Node DEP0190), so any executable or argument holding a
 * space is split apart — a default Windows Node install under `C:\Program Files`
 * never starts, and any user-supplied argument reaches a shell parser. What Windows
 * genuinely cannot start from argv is a `.cmd`/`.bat` shim: either a bare command
 * name that may resolve to one, or an explicit path to one. Those go through the
 * canonical escaped comspec invocation, which quotes what a shell would have split.
 */
export function resolveManagedChildInvocation(params) {
  const platform = params.platform ?? process.platform;
  const command = String(params.command ?? '');
  const args = Array.isArray(params.args) ? [...params.args] : [];
  const isBatchShim = /\.(cmd|bat)$/i.test(command);
  if (platform !== 'win32' || (/[\\/]/.test(command) && !isBatchShim)) {
    return { command, args };
  }
  return buildWindowsCmdShimInvocation(command, args, { comspec: params.comspec });
}

export function resolveSignalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGHUP') return 129;
  return 1;
}

export function installParentDeathCleanupWatchdog(params) {
  const initialParentPid = process.ppid;
  if (!Number.isInteger(initialParentPid) || initialParentPid <= 1) {
    return () => {};
  }

  const pollMs = Number.isFinite(params.pollMs) && params.pollMs > 0 ? params.pollMs : 1000;
  let active = true;
  const timer = setInterval(() => {
    if (!active) return;
    const currentParentPid = process.ppid;
    if (currentParentPid === initialParentPid) return;
    active = false;
    clearInterval(timer);
    void params.onParentDeath(currentParentPid, initialParentPid);
  }, pollMs);

  timer.unref?.();

  return () => {
    active = false;
    clearInterval(timer);
  };
}

export function createManagedChildLifecycle(child, options = {}) {
  const cleanupPollMs = Number.isFinite(options.cleanupPollMs) && options.cleanupPollMs > 0 ? options.cleanupPollMs : 25;
  const signalCleanupGraceMs = Number.isFinite(options.signalCleanupGraceMs) && options.signalCleanupGraceMs >= 0
    ? options.signalCleanupGraceMs
    : 0;
  const signals = Array.isArray(options.processSignals) && options.processSignals.length > 0
    ? options.processSignals
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];

  let cleanupStarted = false;
  let disposed = false;
  const signalHandlers = new Map();

  async function cleanupChild(signal = 'SIGTERM', overrideOptions = {}) {
    if (cleanupStarted) return;
    cleanupStarted = true;

    if (typeof child.pid === 'number' && child.pid > 0) {
      await terminateProcessTreeByPid(child.pid, {
        graceMs: Number.isFinite(overrideOptions.graceMs) ? overrideOptions.graceMs : signalCleanupGraceMs,
        pollMs: Number.isFinite(overrideOptions.pollMs) ? overrideOptions.pollMs : cleanupPollMs,
        skipAliveCheck: overrideOptions.skipAliveCheck === true,
      });
      return;
    }

    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
    stopParentWatchdog();
  }

  for (const signal of signals) {
    const handler = () => {
      void Promise.resolve(options.onProcessSignal?.(signal))
        .catch(() => {})
        .then(() => cleanupChild(signal));
    };
    process.on(signal, handler);
    signalHandlers.set(signal, handler);
  }

  const stopParentWatchdog = installParentDeathCleanupWatchdog({
    pollMs: options.parentWatchdogPollMs,
    onParentDeath: async (currentParentPid, initialParentPid) => {
      await cleanupChild('SIGTERM');
      await options.onParentDeath?.(currentParentPid, initialParentPid);
    },
  });

  async function finalizeChildExit(overrideOptions = {}) {
    dispose();
    if (typeof child.pid !== 'number' || child.pid <= 0) return;
    await terminateProcessTreeByPid(child.pid, {
      graceMs: Number.isFinite(overrideOptions.graceMs) ? overrideOptions.graceMs : 1_000,
      pollMs: Number.isFinite(overrideOptions.pollMs) ? overrideOptions.pollMs : cleanupPollMs,
      skipAliveCheck: overrideOptions.skipAliveCheck !== false,
    }).catch(() => {});
  }

  return {
    cleanupChild,
    dispose,
    finalizeChildExit,
  };
}

export async function runManagedChildCommand(params) {
  // `shell` is not a caller option here: this function owns how a managed child is
  // started, and a shell both corrupts argv and hides the child behind an extra
  // process that the lifecycle's process-tree cleanup would have to chase.
  const { shell: _callerShell, ...spawnOptions } = params.spawnOptions ?? {};
  const invocation = resolveManagedChildInvocation({
    command: params.command,
    args: params.args,
  });
  const child = spawn(invocation.command, invocation.args, {
    ...spawnOptions,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    detached: spawnOptions.detached ?? (process.platform !== 'win32'),
  });

  const lifecycle = createManagedChildLifecycle(child, {
    cleanupPollMs: params.cleanupPollMs,
    signalCleanupGraceMs: params.signalCleanupGraceMs,
    parentWatchdogPollMs: params.parentWatchdogPollMs,
    onProcessSignal: params.onProcessSignal,
    onParentDeath: params.onParentDeath,
  });

  // A wrapper that owns a whole test lane also owns its wall-clock bound: the
  // bound has to terminate the managed child's process tree, which only this
  // lifecycle can reach, so the caller cannot enforce it from outside.
  const maxRuntimeMs = Number.isFinite(params.maxRuntimeMs) && params.maxRuntimeMs > 0 ? params.maxRuntimeMs : null;
  let timedOut = false;
  let runtimeTimer = null;

  function clearRuntimeTimer() {
    if (!runtimeTimer) return;
    clearTimeout(runtimeTimer);
    runtimeTimer = null;
  }

  return await new Promise((resolve) => {
    if (maxRuntimeMs) {
      runtimeTimer = setTimeout(() => {
        timedOut = true;
        void Promise.resolve(params.onMaxRuntime?.(maxRuntimeMs))
          .catch(() => {})
          .then(() => lifecycle.cleanupChild('SIGTERM'));
      }, maxRuntimeMs);
      runtimeTimer.unref?.();
    }

    child.once('error', (error) => {
      clearRuntimeTimer();
      lifecycle.dispose();
      resolve({
        child,
        ok: false,
        error,
        timedOut,
      });
    });

    child.once('exit', async (code, signal) => {
      clearRuntimeTimer();
      await lifecycle.finalizeChildExit({
        graceMs: params.exitCleanupGraceMs,
        pollMs: params.cleanupPollMs,
        skipAliveCheck: true,
      });
      resolve({
        child,
        ok: true,
        code,
        signal,
        timedOut,
      });
    });
  });
}
