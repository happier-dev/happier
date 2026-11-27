import { spawn } from 'node:child_process';
import { releaseChildFromLauncher, spawnChildWithLauncherLifeline } from '../utils/execution_host/foreground_child.mjs';

import { killProcessTree } from '../utils/proc/proc.mjs';

// A background runner outlives start, but Ctrl-C must still cancel it while
// start owns readiness. Both pinned and allocated ports share this handoff.
export function spawnBackgroundStackRunner(scriptPath, args, { rootDir, env, logFd }) {
  // A worker's remote observer transports readiness for the durable Stack.
  // Losing that transport must not stop the recorded owner.
  const start = env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? spawn : spawnChildWithLauncherLifeline;
  const child = start(process.execPath, [scriptPath, ...args], {
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
      releaseChildFromLauncher(child);
      child.unref();
    },
  };
}
