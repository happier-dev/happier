import { logger } from '@/ui/logger';

import { isDaemonRunningCurrentlyInstalledHappyVersion } from './controlClient';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

const DEFAULT_STARTUP_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_POLL_MS = 250;

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function shouldEnsureDaemonForInvocation(params: Readonly<{ args: string[] }>): boolean {
  const args = Array.isArray(params.args) ? params.args : [];
  if (args.includes('-h') || args.includes('--help')) return false;
  if (args.includes('-v') || args.includes('--version')) return false;

  const subcommand = args[0];
  const nonSession = new Set(['auth', 'doctor', 'daemon', 'notify', 'connect', 'logout', 'attach', 'self']);
  if (subcommand && nonSession.has(subcommand)) return false;

  // Default invocation (no explicit subcommand) starts a session.
  return true;
}

export function shouldAutoStartDaemonAfterAuth(params: Readonly<{ env: NodeJS.ProcessEnv; isDaemonProcess: boolean }>): boolean {
  if (params.isDaemonProcess) return false;
  const raw = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export function applyDaemonAutostartEnvForInvocation(params: Readonly<{ args: string[]; env: NodeJS.ProcessEnv }>): void {
  if (!shouldEnsureDaemonForInvocation({ args: params.args })) return;
  const current = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim();
  if (current.length > 0) return;
  params.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '1';
}

export async function ensureDaemonRunningForSessionCommand(): Promise<void> {
  if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
    logger.debug('Starting Happier background service...');
    const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
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
