import { spawn } from 'node:child_process';

const launcherLifeline = new URL('./launcher_lifeline.mjs', import.meta.url).href;

// A detached Node child is outside the launcher's process group, so it cannot
// see the launcher being SIGKILLed. Give it an IPC lifeline that closes with the
// launcher; launcher_lifeline.mjs turns that close into the child's hangup.
function withLauncherLifeline(command, args, options = {}) {
  if (command !== process.execPath) return { args, options };
  const stdio = options.stdio ?? 'pipe';
  return {
    args: [`--import=${launcherLifeline}`, ...args],
    options: { ...options, stdio: [...(Array.isArray(stdio) ? stdio : [stdio, stdio, stdio]), 'ipc'] },
  };
}

export function defaultForegroundChildBoundary() {
  return {
    spawn(command, args, options) {
      const launched = withLauncherLifeline(command, args, options);
      return spawn(command, launched.args, launched.options);
    },
    onSignal(handler) {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of signals) process.on(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    },
  };
}

export async function runForegroundChild({ command, args, options, boundary = defaultForegroundChildBoundary() }) {
  const child = boundary.spawn(command, args, options);
  let interruptionSignal = null;
  const removeSignalHandlers = boundary.onSignal((signal) => {
    interruptionSignal ??= signal;
    try {
      child.kill(signal);
    } catch {
      // The child may already have reached its terminal state.
    }
  });
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', (exitCode, signal) => resolvePromise(
        interruptionSignal ? { exitCode: null, signal: interruptionSignal } : { exitCode, signal },
      ));
    });
  } finally {
    removeSignalHandlers();
  }
}
