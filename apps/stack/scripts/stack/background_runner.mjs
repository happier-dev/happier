import { spawn } from 'node:child_process';

import { killProcessTree } from '../utils/proc/proc.mjs';

// A background runner outlives start, but Ctrl-C must still cancel it while
// start owns readiness. Both pinned and allocated ports share this handoff.
export function spawnBackgroundStackRunner(scriptPath, args, { rootDir, env, logFd }) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    env,
    stdio: ['ignore', logFd, logFd],
    shell: false,
    // POSIX creates a new session/group. Windows gives the runner its own
    // console; hide it while retaining independence from the starter's console.
    detached: true,
    windowsHide: true,
  });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    if (!child.pid || child.exitCode != null || child.signalCode != null) return;
    if (process.platform === 'win32') {
      // Windows signals terminate one process abruptly; reuse owned-tree cleanup.
      void killProcessTree(child, signal).then(result => {
        if (!result.ok) console.error('[stack] background runner cancellation failed');
      }, () => console.error('[stack] background runner cancellation failed'));
    } else {
      child.kill(signal);
    }
  }]));
  const dispose = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.once('error', dispose);
  child.once('exit', dispose);
  return {
    child,
    release() {
      dispose();
      child.unref();
    },
  };
}
