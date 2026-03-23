import { logger } from '@/ui/logger';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { readStartedByArg } from '@/cli/readStartedByArg';

import { isDaemonRunningCurrentlyInstalledHappyVersion } from './controlClient';
import { spawnDetachedDaemonStartSync } from './runtime/spawnDetachedDaemonStartSync';

const DEFAULT_STARTUP_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_POLL_MS = 250;

export function shouldEnsureDaemonForInvocation(params: Readonly<{ args: string[] }>): boolean {
  const args = Array.isArray(params.args) ? params.args : [];
  if (args.includes('-h') || args.includes('--help')) return false;
  if (args.includes('-v') || args.includes('--version')) return false;

  const subcommand = args[0];
  const nonSession = new Set(['auth', 'doctor', 'daemon', 'notify', 'connect', 'logout', 'attach', 'self', 'server', 'session']);
  if (subcommand && nonSession.has(subcommand)) return false;

  // Default invocation (no explicit subcommand) starts a session.
  return true;
}

export function shouldAutoStartDaemonAfterAuth(
  params: Readonly<{ env: NodeJS.ProcessEnv; isDaemonProcess: boolean; startedBy: 'daemon' | 'terminal' }>,
): boolean {
  if (params.isDaemonProcess) return false;
  if (params.startedBy === 'daemon') return false;
  const raw = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export function applyDaemonAutostartEnvForInvocation(params: Readonly<{ args: string[]; env: NodeJS.ProcessEnv }>): void {
  if (!shouldEnsureDaemonForInvocation({ args: params.args })) return;
  if (readStartedByArg(params.args).value === 'daemon') return;
  const current = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim();
  if (current.length > 0) return;
  params.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '1';
}

export async function ensureDaemonRunningForSessionCommand(): Promise<void> {
  if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
    logger.debug('Starting Happier background service...');
    const daemonProcess = await spawnDetachedDaemonStartSync();
    daemonProcess.unref();

    const timeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS', DEFAULT_STARTUP_WAIT_TIMEOUT_MS);
    const pollMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_POLL_MS', DEFAULT_STARTUP_POLL_MS);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (await isDaemonRunningCurrentlyInstalledHappyVersion()) {
        return;
      }
    }
    logger.debug(`Daemon did not report ready within ${timeoutMs}ms; continuing`);
  }
}
