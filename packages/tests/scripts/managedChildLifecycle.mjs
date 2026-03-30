import { spawn } from 'node:child_process';

import { terminateProcessTreeByPid } from './processTree.mjs';

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
  const child = spawn(params.command, params.args, {
    ...params.spawnOptions,
    detached: params.spawnOptions?.detached ?? (process.platform !== 'win32'),
  });

  const lifecycle = createManagedChildLifecycle(child, {
    cleanupPollMs: params.cleanupPollMs,
    signalCleanupGraceMs: params.signalCleanupGraceMs,
    parentWatchdogPollMs: params.parentWatchdogPollMs,
    onProcessSignal: params.onProcessSignal,
    onParentDeath: params.onParentDeath,
  });

  return await new Promise((resolve) => {
    child.once('error', (error) => {
      lifecycle.dispose();
      resolve({
        child,
        ok: false,
        error,
      });
    });

    child.once('exit', async (code, signal) => {
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
      });
    });
  });
}
