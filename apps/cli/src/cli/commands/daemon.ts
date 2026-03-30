import chalk from 'chalk';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { checkIfDaemonRunningAndCleanupStaleState, listDaemonSessions, stopDaemon, stopDaemonSession } from '@/daemon/controlClient';
import { startDaemon } from '@/daemon/startDaemon';
import {
  resolveDaemonServiceInstallationSnapshotFromEnv,
  runDaemonServiceCliCommand,
} from '@/daemon/service/cli';
import { getLatestDaemonLog } from '@/ui/logger';
import { runDoctorCommand } from '@/ui/doctor';
import { listDaemonStatusesForAllKnownServers, stopAllDaemonsBestEffort } from '@/daemon/multiDaemon';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { readCredentials, readSettings } from '@/persistence';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveLaunchAgentPlistPath, resolveSystemdUserUnitPath } from '@/daemon/service/plan';
import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleDaemonCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;
  const daemonSubcommand = args[1];

  if (daemonSubcommand === 'service') {
    const serviceAction = args[2];
      if (serviceAction === 'list') {
        const json = args.includes('--json');
        const userHomeDir = (process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR ?? '').trim() || homedir();
        const happierHomeDir = (process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR ?? '').trim() || configuration.happyHomeDir;
        const settings = await readSettings();
        const servers = settings.servers ?? {};
        const entries = Object.values(servers);
      if (entries.length === 0) {
        if (json) {
          process.stdout.write(`${JSON.stringify({ entries: [] })}\n`);
          return;
        }
        console.log('(no server profiles configured)');
        return;
      }

      const normalizedEntries = entries
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .map((profile) => {
          const instanceId = String(profile.id ?? '').trim();
          const env = {
            ...process.env,
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: instanceId,
            HAPPIER_DAEMON_SERVICE_SERVER_URL: String(profile.serverUrl ?? '').trim(),
            HAPPIER_DAEMON_SERVICE_WEBAPP_URL: String(profile.webappUrl ?? '').trim(),
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
          };
          const service = resolveDaemonServiceInstallationSnapshotFromEnv({ processEnv: env });
          return {
            serverId: instanceId,
            name: String(profile.name ?? instanceId).trim() || instanceId,
            installed: service.installed,
            path: service.installedPath,
            platform: service.platform,
          };
        })
        .filter((entry) => entry.installed);

      if (json) {
        process.stdout.write(`${JSON.stringify({ entries: normalizedEntries })}\n`);
        return;
      }

      if (normalizedEntries.length === 0) {
        console.log('(no daemon services installed)');
        return;
      }

      for (const entry of normalizedEntries) {
        console.log(`${entry.name} (${entry.serverId})`);
        console.log(`  ${entry.installed ? 'installed' : 'not installed'}: ${entry.path}`);
      }
      return;
    }

    await runDaemonServiceCliCommand({ argv: args.slice(2) });
    return;
  }

  if (daemonSubcommand === 'list') {
    try {
      const sessions = await listDaemonSessions();

      if (sessions.length === 0) {
        console.log(
          'No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)',
        );
      } else {
        console.log('Active sessions:');
        console.log(JSON.stringify(sessions, null, 2));
      }
    } catch {
      console.log('No daemon running');
    }
    return;
  }

  if (daemonSubcommand === 'stop-session') {
    const sessionId = args[2];
    if (!sessionId) {
      console.error('Session ID required');
      process.exit(1);
    }

    try {
      const success = await stopDaemonSession(sessionId);
      console.log(success ? 'Session stopped' : 'Failed to stop session');
    } catch {
      console.log('No daemon running');
    }
    return;
  }

  if (daemonSubcommand === 'start') {
    const child = await spawnDetachedDaemonStartSync();
    child.unref();

    const timeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS', 5000);
    const pollMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_POLL_MS', 100);
    const started = await waitForDaemonRunningWithinBudget({
      isRunning: () => checkIfDaemonRunningAndCleanupStaleState(),
      timeoutMs,
      pollMs,
    });

    if (started) {
      console.log('Daemon started successfully');
      console.log(`  Server: ${configuration.serverUrl}`);
      console.log(`  Server ID: ${configuration.activeServerId}`);
      try {
        const creds = await readCredentials();
        const payload = creds?.token ? decodeJwtPayload(creds.token) : null;
        const sub = typeof payload?.sub === 'string' ? payload.sub : '';
        if (sub) console.log(`  Account: ${sub}`);
      } catch {
        // ignore
      }
    } else {
      console.error('Failed to start daemon');
      const latestDaemonLog = await getLatestDaemonLog().catch(() => null);
      if (latestDaemonLog?.path) {
        console.error(`Latest daemon log: ${latestDaemonLog.path}`);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'start-sync') {
    await startDaemon();
    process.exit(0);
  }

  if (daemonSubcommand === 'stop') {
    const stopSessions = args.includes('--kill-sessions');
    if (args.includes('--all')) {
      await stopAllDaemonsBestEffort({ stopSessions });
      process.exit(0);
    }
    await stopDaemon({ stopSessions });
    process.exit(0);
  }

  if (daemonSubcommand === 'status') {
      if (args.includes('--json')) {
      if (args.includes('--all')) {
        const statuses = await listDaemonStatusesForAllKnownServers();
        const activeRelayUrl = configuration.publicServerUrl || configuration.serverUrl;
        const activeComparableKey = (() => {
          try {
            return createServerUrlComparableKey(activeRelayUrl);
          } catch {
            return null;
          }
        })();
        process.stdout.write(`${JSON.stringify({
          active: {
            serverId: configuration.activeServerId,
            relayUrl: activeRelayUrl,
            comparableKey: activeComparableKey,
          },
          entries: statuses.map((entry) => {
            let servicePlatform = typeof entry.service.platform === 'string' ? entry.service.platform : null;
            let serviceInstalledPath = typeof entry.service.installedPath === 'string' ? entry.service.installedPath : null;
            if (!servicePlatform || !serviceInstalledPath) {
              try {
                const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv({
                  processEnv: {
                    ...process.env,
                    HAPPIER_DAEMON_SERVICE_INSTANCE_ID: entry.serverId,
                    HAPPIER_DAEMON_SERVICE_SERVER_URL: entry.serverUrl,
                  },
                });
                if (!servicePlatform) servicePlatform = snapshot.platform;
                if (!serviceInstalledPath) serviceInstalledPath = snapshot.installedPath;
              } catch {
                // ignore
              }
            }

            return {
            serverId: entry.serverId,
            name: entry.name,
            serverUrl: entry.serverUrl,
            daemonStatePath: entry.daemonStatePath,
            comparableKey: entry.comparableKey,
            ...(entry.auth ? { auth: entry.auth } : {}),
            ...(entry.drift ? { drift: { ...entry.drift, activeRelayUrl: activeRelayUrl } } : {}),
            service: {
              installed: entry.service.installed,
              running: typeof entry.service.running === 'boolean'
                ? entry.service.running
                : entry.service.installed && entry.daemon.running,
              platform: servicePlatform,
              installedPath: serviceInstalledPath,
            },
            daemon: {
              installed: entry.service.installed,
              running: entry.daemon.running,
              pid: entry.daemon.pid,
              httpPort: entry.daemon.httpPort ?? null,
              staleStateFile: Boolean(entry.daemon.staleStateFile),
            },
            };
          }),
        })}\n`);
        process.exit(0);
      }
      const snapshot = await readDaemonStatusSnapshot();
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
      process.exit(0);
    }

    if (args.includes('--all')) {
      const statuses = await listDaemonStatusesForAllKnownServers();
      for (const entry of statuses) {
        const state = entry.daemon.running ? `running (pid ${entry.daemon.pid ?? '—'})` : 'not running';
        console.log(`${entry.name} (${entry.serverId})`);
        if (entry.serverUrl) console.log(`  Server: ${entry.serverUrl}`);
        console.log(`  Daemon: ${state}`);
        if (entry.daemon.staleStateFile) console.log(`  Note: stale state file: ${entry.daemonStatePath}`);
        console.log('');
      }
      process.exit(0);
    }
    await runDoctorCommand('daemon');
    process.exit(0);
  }

  if (daemonSubcommand === 'logs') {
    const latest = await getLatestDaemonLog();
    if (!latest) {
      console.log('No daemon logs found');
    } else {
      console.log(latest.path);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'install') {
    try {
      await runDaemonServiceCliCommand({ argv: ['install', ...args.slice(2)] });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    return;
  }

  if (daemonSubcommand === 'uninstall') {
    try {
      await runDaemonServiceCliCommand({ argv: ['uninstall', ...args.slice(2)] });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    return;
  }

  console.log(`
${chalk.bold('happier daemon')} - Daemon management

${chalk.bold('Usage:')}
  happier daemon start              Start the daemon (detached)
  happier daemon stop               Stop the daemon (sessions stay alive)
  happier daemon stop --kill-sessions  Stop the daemon and its tracked sessions
  happier daemon stop --all         Stop daemons for all configured servers
  happier daemon status             Show daemon status
  happier daemon status --all       Show daemon status for all configured servers
  happier daemon list               List active sessions
  happier daemon install            Install daemon as a user service (macOS/Linux)
  happier daemon uninstall          Uninstall daemon user service (macOS/Linux)
  happier daemon service            Manage daemon as a user service
  happier daemon service list       List installed daemon services by server profile

  Prefix with --server/--server-url to target a specific server profile for this invocation.
  Example: happier --server company daemon service install

  If you want to kill all happier related processes run 
  ${chalk.cyan('happier doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Happier sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('happier doctor clean')}
`);
}
