import { logger } from '@/ui/logger';
import { warn } from '@happier-dev/cli-common/output';
export {
  applyDaemonAutostartEnvForInvocation,
  shouldAutoStartDaemonAfterAuth,
  shouldEnsureDaemonForInvocation,
} from '@/daemon/daemonAutostartPolicy';

import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { renderDaemonOwnerConflict } from '@/daemon/ownership/renderDaemonOwnerConflict';
import {
  isDaemonStartupSourceServiceManaged,
  resolveDaemonStartupSourceFromEnv,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import {
  DEFAULT_SESSION_AUTOSTART_DAEMON_WAIT_POLL_MS,
  readDaemonStartWaitPollMs,
  readDaemonStartWaitTimeoutMs,
} from '@/daemon/startupWaitDefaults';
import { hasObservableDaemonStartProcessExited } from '@/daemon/waitForDaemonRunningWithinBudget';

export async function ensureDaemonRunningForSessionCommand(): Promise<void> {
  const ownership = await evaluateCurrentDaemonOwner();
  if (ownership.kind === 'compatible') {
    return;
  }
  if (ownership.kind === 'conflict') {
    const message = renderDaemonOwnerConflict({
      intent: 'session-autostart',
      owner: ownership.owner,
    });
    console.log(warn(message.title));
    for (const line of message.lines) {
      console.log(`  ${line}`);
    }
    return;
  }

  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  if (isDaemonStartupSourceServiceManaged(startupSource) || startupSource === 'self-restart') {
    return;
  }

  if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
    logger.debug('Starting Happier background service...');
    const daemonProcess = await spawnDetachedDaemonStartSync();
    daemonProcess.unref();

    const timeoutMs = readDaemonStartWaitTimeoutMs();
    const pollMs = readDaemonStartWaitPollMs(DEFAULT_SESSION_AUTOSTART_DAEMON_WAIT_POLL_MS);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (await isDaemonRunningCurrentlyInstalledHappyVersion()) {
        return;
      }
      if (hasObservableDaemonStartProcessExited(daemonProcess)) {
        return;
      }
    }
    logger.debug(`Daemon did not report ready within ${timeoutMs}ms; continuing`);
  }
}
