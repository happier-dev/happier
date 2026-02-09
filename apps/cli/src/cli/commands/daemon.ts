import chalk from 'chalk';

import { checkIfDaemonRunningAndCleanupStaleState, listDaemonSessions, stopDaemon, stopDaemonSession } from '@/daemon/controlClient';
import { install } from '@/daemon/install';
import { startDaemon } from '@/daemon/run';
import { runDaemonServiceCliCommand } from '@/daemon/service/cli';
import { uninstall } from '@/daemon/uninstall';
import { getLatestDaemonLog } from '@/ui/logger';
import { runDoctorCommand } from '@/ui/doctor';
import { listDaemonStatusesForAllKnownServers, stopAllDaemonsBestEffort } from '@/daemon/multiDaemon';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { readCredentials, readSettings } from '@/persistence';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolveLaunchAgentPlistPath, resolveSystemdUserUnitPath } from '@/daemon/service/plan';
import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleDaemonCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;
  const daemonSubcommand = args[1];

  if (daemonSubcommand === 'service') {
    const serviceAction = args[2];
    if (serviceAction === 'list') {
      const platformRaw = (process.env.HAPPIER_DAEMON_SERVICE_PLATFORM ?? '').toString().trim().toLowerCase();
      const platform = platformRaw === 'linux' ? 'linux' : (platformRaw === 'darwin' || platformRaw === 'mac' || platformRaw === 'macos' || platformRaw === 'osx') ? 'darwin' : (process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : null);
      if (!platform) {
        console.error('Daemon service is currently only supported on macOS and Linux');
        process.exit(1);
      }

      const userHomeDir = (process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR ?? '').trim() || homedir();
      const settings = await readSettings();
      const servers = settings.servers ?? {};
      const entries = Object.values(servers);
      if (entries.length === 0) {
        console.log('(no server profiles configured)');
        return;
      }

      for (const profile of entries.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))) {
        const instanceId = profile.id;
        const path =
          platform === 'darwin'
            ? resolveLaunchAgentPlistPath({ userHomeDir, instanceId })
            : resolveSystemdUserUnitPath({ userHomeDir, instanceId });
        const installed = existsSync(path);
        console.log(`${profile.name} (${instanceId})`);
        console.log(`  ${installed ? 'installed' : 'not installed'}: ${path}`);
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
    const child = spawnHappyCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();

    let started = false;
    for (let i = 0; i < 50; i++) {
      if (await checkIfDaemonRunningAndCleanupStaleState()) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

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
      process.exit(1);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'start-sync') {
    await startDaemon();
    process.exit(0);
  }

  if (daemonSubcommand === 'stop') {
    if (args.includes('--all')) {
      await stopAllDaemonsBestEffort();
      process.exit(0);
    }
    await stopDaemon();
    process.exit(0);
  }

  if (daemonSubcommand === 'status') {
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
      await install();
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    return;
  }

  if (daemonSubcommand === 'uninstall') {
    try {
      await uninstall();
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
