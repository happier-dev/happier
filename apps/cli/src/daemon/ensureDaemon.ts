import { logger } from '@/ui/logger';
import { readStartedByArg } from '@/cli/readStartedByArg';

import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { renderDaemonOwnerConflict } from '@/daemon/ownership/renderDaemonOwnerConflict';
import { evaluateDaemonStartupServiceConflict, renderDaemonInstalledServiceConflict } from '@/daemon/ownership/daemonServiceInventory';
import {
  isDaemonStartupSourceServiceManaged,
  resolveDaemonStartupSourceFromEnv,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import {
  DEFAULT_SESSION_AUTOSTART_DAEMON_WAIT_POLL_MS,
  readDaemonStartWaitPollMs,
  readDaemonStartWaitTimeoutMs,
} from '@/daemon/startupWaitDefaults';

export function shouldEnsureDaemonForInvocation(params: Readonly<{ args: string[] }>): boolean {
  const args = Array.isArray(params.args) ? params.args : [];
  if (args.includes('-h') || args.includes('--help')) return false;
  if (args.includes('-v') || args.includes('--version')) return false;

  const subcommand = args[0];
  const nonSession = new Set([
    'auth',
    'doctor',
    'daemon',
    'notify',
    'connect',
    'logout',
    'attach',
    'capabilities',
    'self',
    'server',
    'session',
    'sessions',
  ]);
  if (subcommand && nonSession.has(subcommand)) return false;

  // Default invocation (no explicit subcommand) starts a session.
  return true;
}

export function shouldAutoStartDaemonAfterAuth(
  params: Readonly<{
    env: NodeJS.ProcessEnv;
    isDaemonProcess: boolean;
    startedBy: 'daemon' | 'terminal';
    callerIntent?: 'standalone' | 'setup-managed';
  }>,
): boolean {
  if (params.callerIntent === 'setup-managed') return false;
  if (params.isDaemonProcess) return false;
  if (params.startedBy === 'daemon') return false;
  const raw = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export function applyDaemonAutostartEnvForInvocation(params: Readonly<{
  args: string[];
  env: NodeJS.ProcessEnv;
  autostartInInteractiveTerminal?: boolean;
}>): void {
  const startedBy = readStartedByArg(params.args);
  const current = (params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim();
  if (!current && params.autostartInInteractiveTerminal === false
    && startedBy.value !== 'daemon' && !(startedBy.present && startedBy.value === null)
    && process.stdin.isTTY && process.stdout.isTTY) {
    params.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '0';
  }
  if (!shouldEnsureDaemonForInvocation({ args: params.args })) return;
  if (readStartedByArg(params.args).value === 'daemon') return;
  if ((params.env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').toString().trim().length > 0) return;
  params.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '1';
}

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
    console.log(message.title);
    for (const line of message.lines) {
      console.log(`  ${line}`);
    }
    return;
  }

  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  if (isDaemonStartupSourceServiceManaged(startupSource) || startupSource === 'self-restart') {
    return;
  }

  try {
    const runtime = resolveDaemonServiceCliRuntimeFromEnv();
    const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
      startupSource,
      runtime,
    });
    if (startupServiceConflict.kind === 'installed-background-service-conflict') {
      const message = renderDaemonInstalledServiceConflict({
        action: 'session-autostart',
        services: startupServiceConflict.services,
      });
      console.log(message.title);
      for (const line of message.lines) {
        console.log(line.startsWith('  ') ? line : `  ${line}`);
      }
      return;
    }
  } catch {
    // best-effort
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
    }
    logger.debug(`Daemon did not report ready within ${timeoutMs}ms; continuing`);
  }
}
