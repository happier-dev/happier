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
import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';
import { handleServiceRepairCliCommand } from './serviceRepair/handleServiceRepairCliCommand';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { renderDaemonOwnerConflict } from '@/daemon/ownership/renderDaemonOwnerConflict';
import {
  buildDaemonTakeoverNotice,
} from '@/daemon/ownership/resolveDaemonTakeoverDecision';
import {
  evaluateDaemonStartupServiceConflict,
  renderDaemonInstalledServiceConflict,
} from '@/daemon/ownership/daemonServiceInventory';
import {
  isDaemonStartupSourceServiceManaged,
  resolveDaemonStartupSourceFromEnv,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

import type { CommandContext } from '@/cli/commandRegistry';
import { cmd, errorFrame, kv, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

function printDaemonJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function flattenDaemonMessage(title: string, lines: readonly string[]): string {
  return [title, ...lines].join(' ').trim();
}

export async function handleDaemonCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;
  const daemonSubcommand = args[1];

  if (daemonSubcommand === 'service') {
    if (args[2] === 'repair') {
      await handleServiceRepairCliCommand({
        argv: args.slice(2),
        commandPath: 'happier daemon service',
      });
      return;
    }
    await runDaemonServiceCliCommand({ argv: args.slice(2) });
    return;
  }

  if (daemonSubcommand === 'list') {
    try {
      const sessions = await listDaemonSessions();

      if (sessions.length === 0) {
        console.log(neutral('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)'));
      } else {
        console.log(sectionTitle('Active sessions'));
        console.log(JSON.stringify(sessions, null, 2));
      }
    } catch {
      console.log(warn('No daemon running'));
    }
    return;
  }

  if (daemonSubcommand === 'stop-session') {
    const sessionId = args[2];
    if (!sessionId) {
      console.error(errorFrame('Error:', ['Session ID required']));
      process.exit(1);
    }

    try {
      const success = await stopDaemonSession(sessionId);
      console.log(success ? ok('Session stopped') : warn('Failed to stop session'));
    } catch {
      console.log(warn('No daemon running'));
    }
    return;
  }

  if (daemonSubcommand === 'start') {
    const jsonRequested = args.includes('--json');
    const takeoverRequested = args.includes('--takeover');
    const ownership = await evaluateCurrentDaemonOwner();
    const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
    if (ownership.kind === 'compatible') {
      if (jsonRequested) {
        printDaemonJson({
          ok: true,
          status: 'already_running',
          relay: configuration.serverUrl,
          relayId: configuration.activeServerId,
        });
      } else {
        console.log(ok('Daemon already running'));
        console.log(`  ${kv('Relay:', configuration.serverUrl)}`);
        console.log(`  ${kv('Relay ID:', configuration.activeServerId)}`);
      }
      process.exit(0);
    }
    const takeoverAllowed = takeoverRequested
      && ownership.kind === 'conflict'
      && ownership.owner.serviceManaged === false;

    if (ownership.kind === 'conflict' && !takeoverAllowed) {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-start',
        owner: ownership.owner,
      });
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'owner_conflict',
          message: flattenDaemonMessage(message.title, message.lines),
        });
      } else {
        console.error(errorFrame(message.title, [...message.lines]));
      }
      process.exit(1);
    }

    if (!isDaemonStartupSourceServiceManaged(startupSource) && startupSource !== 'self-restart') {
      const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
        startupSource,
        runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
      });
      if (startupServiceConflict.kind === 'installed-background-service-conflict') {
        const message = renderDaemonInstalledServiceConflict({
          action: 'daemon-start',
          services: startupServiceConflict.services,
        });
        if (jsonRequested) {
          printDaemonJson({
            ok: false,
            error: 'installed_background_service_conflict',
            message: flattenDaemonMessage(message.title, message.lines),
          });
        } else {
          console.error(errorFrame(message.title, [...message.lines]));
        }
        process.exit(1);
      }
    }

    if (takeoverAllowed && !jsonRequested) {
      console.log(warn('Taking over the current manual relay runtime before starting a new relay...'));
    }

    const spawnOptions = takeoverRequested
      ? {
        env: {
          ...process.env,
          HAPPIER_DAEMON_TAKEOVER: '1',
        },
      }
      : {};
    const child = await spawnDetachedDaemonStartSync(spawnOptions);
    child.unref();

    const timeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS', 5000);
    const pollMs = readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_POLL_MS', 100);
    const started = await waitForDaemonRunningWithinBudget({
      isRunning: () => checkIfDaemonRunningAndCleanupStaleState(),
      timeoutMs,
      pollMs,
    });

    if (started) {
      let account: string | undefined;
      try {
        const creds = await readCredentials();
        const payload = creds?.token ? decodeJwtPayload(creds.token) : null;
        const sub = typeof payload?.sub === 'string' ? payload.sub : '';
        if (sub) account = sub;
      } catch {
        // ignore
      }
      if (jsonRequested) {
        printDaemonJson({
          ok: true,
          status: 'started',
          relay: configuration.serverUrl,
          relayId: configuration.activeServerId,
          ...(account ? { account } : {}),
        });
      } else {
        console.log(ok('Daemon started successfully'));
        console.log(`  ${kv('Relay:', configuration.serverUrl)}`);
        console.log(`  ${kv('Relay ID:', configuration.activeServerId)}`);
        if (account) console.log(`  ${kv('Account:', account)}`);
      }
    } else {
      const latestDaemonLog = await getLatestDaemonLog().catch(() => null);
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'start_failed',
          message: 'Failed to start daemon',
          ...(latestDaemonLog?.path ? { latestDaemonLogPath: latestDaemonLog.path } : {}),
        });
      } else {
        console.error(errorFrame('Failed to start daemon', []));
        if (latestDaemonLog?.path) {
          console.error(`  ${kv('Latest daemon log:', latestDaemonLog.path)}`);
        }
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'start-sync') {
    const takeoverRequested = args.includes('--takeover');
    const ownership = await evaluateCurrentDaemonOwner();
    const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
    if (ownership.kind === 'compatible') {
      console.log(ok('Daemon already running'));
      console.log(`  ${kv('Relay:', configuration.serverUrl)}`);
      console.log(`  ${kv('Relay ID:', configuration.activeServerId)}`);
      process.exit(0);
    }
    const takeoverAllowed = takeoverRequested
      && ownership.kind === 'conflict'
      && ownership.owner.serviceManaged === false;

    if (ownership.kind === 'conflict' && !takeoverAllowed) {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-start-sync',
        owner: ownership.owner,
      });
      console.error(errorFrame(message.title, [...message.lines]));
      process.exit(1);
    }

    if (!isDaemonStartupSourceServiceManaged(startupSource) && startupSource !== 'self-restart') {
      const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
        startupSource,
        runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
      });
      if (startupServiceConflict.kind === 'installed-background-service-conflict') {
        const message = renderDaemonInstalledServiceConflict({
          action: 'daemon-start-sync',
          services: startupServiceConflict.services,
        });
        console.error(errorFrame(message.title, [...message.lines]));
        process.exit(1);
      }
    }

    if (takeoverAllowed) {
      console.log(warn('Taking over the current manual relay runtime before starting a new relay...'));
    }

    await startDaemon({ takeover: takeoverRequested });
    process.exit(0);
  }

  if (daemonSubcommand === 'stop') {
    const stopSessions = args.includes('--kill-sessions');
    if (args.includes('--all')) {
      await stopAllDaemonsBestEffort({ stopSessions });
      process.exit(0);
    }
    const ownership = await evaluateCurrentDaemonOwner();
    if (ownership.kind !== 'none' && ownership.owner.serviceManaged !== false) {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-stop',
        owner: ownership.owner,
      });
      console.error(errorFrame(message.title, [...message.lines]));
      process.exit(1);
    }
    await stopDaemon({ stopSessions });
    process.exit(0);
  }

  if (daemonSubcommand === 'restart') {
    if (args.includes('--all')) {
      console.error(errorFrame('Error:', ['`happier daemon restart --all` is not supported yet.']));
      process.exit(1);
    }

    const ownership = await evaluateCurrentDaemonOwner();
    const takeoverRequested = args.includes('--takeover');
    const takeoverAllowed = takeoverRequested
      && ownership.kind === 'conflict'
      && ownership.owner.serviceManaged === false;
    if (ownership.kind === 'conflict' && !takeoverAllowed) {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-restart',
        owner: ownership.owner,
      });
      console.error(errorFrame(message.title, [...message.lines]));
      process.exit(1);
    }

    const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
    if (!isDaemonStartupSourceServiceManaged(startupSource) && startupSource !== 'self-restart') {
      const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
        startupSource,
        runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
      });
      if (startupServiceConflict.kind === 'installed-background-service-conflict') {
        const message = renderDaemonInstalledServiceConflict({
          action: 'daemon-restart',
          services: startupServiceConflict.services,
        });
        console.error(errorFrame(message.title, [...message.lines]));
        process.exit(1);
      }
    }

    if (takeoverAllowed) {
      const notice = buildDaemonTakeoverNotice({ action: 'restart' });
      console.log(warn(notice.title));
      for (const line of notice.lines) {
        console.log(`  ${line}`);
      }
    }

    const stopSessions = args.includes('--kill-sessions');
    const started = await restartDaemonAndWait({ stopSessions, takeover: takeoverRequested });

    if (started) {
      console.log(ok('Daemon restarted successfully'));
      console.log(`  ${kv('Relay:', configuration.serverUrl)}`);
      console.log(`  ${kv('Relay ID:', configuration.activeServerId)}`);
      process.exit(0);
    }

    console.error(errorFrame('Failed to restart daemon', []));
    const latestDaemonLog = await getLatestDaemonLog().catch(() => null);
    if (latestDaemonLog?.path) {
      console.error(`  ${kv('Latest daemon log:', latestDaemonLog.path)}`);
    }
    process.exit(1);
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
        const entries = await Promise.all(statuses.map(async (entry) => {
          let servicePlatform = typeof entry.service.platform === 'string' ? entry.service.platform : null;
          let serviceInstalledPath = typeof entry.service.installedPath === 'string' ? entry.service.installedPath : null;
          if (!servicePlatform || !serviceInstalledPath) {
            try {
              const snapshot = await resolveDaemonServiceInstallationSnapshotFromEnv({
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
        }));
        process.stdout.write(`${JSON.stringify({
          active: {
            serverId: configuration.activeServerId,
            relayUrl: activeRelayUrl,
            comparableKey: activeComparableKey,
          },
          entries,
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
        console.log(sectionTitle(`${entry.name} (${entry.serverId})`));
        if (entry.serverUrl) console.log(`  ${kv('Relay:', entry.serverUrl)}`);
        console.log(`  ${kv('Daemon:', state)}`);
        if (entry.daemon.staleStateFile) console.log(`  ${kv('Note:', `stale state file: ${entry.daemonStatePath}`)}`);
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
      console.log(neutral('No daemon logs found'));
    } else {
      console.log(latest.path);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'install') {
    try {
      await runDaemonServiceCliCommand({ argv: ['install', ...args.slice(2)] });
    } catch (error) {
      console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
      process.exit(1);
    }
    return;
  }

  if (daemonSubcommand === 'uninstall') {
    try {
      await runDaemonServiceCliCommand({ argv: ['uninstall', ...args.slice(2)] });
    } catch (error) {
      console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
      process.exit(1);
    }
    return;
  }

  console.log([
    `${sectionTitle('happier daemon')} - Daemon management`,
    '',
    sectionTitle('Usage:'),
    `  ${cmd('happier daemon start')}                 Start the daemon (detached)`,
    `  ${cmd('happier daemon start --takeover')}      Start and take over an existing manual relay runtime`,
    `  ${cmd('happier daemon restart')}               Restart the daemon (stop → start)`,
    `  ${cmd('happier daemon stop')}                  Stop the daemon (sessions stay alive)`,
    `  ${cmd('happier daemon stop --kill-sessions')}  Stop the daemon and its tracked sessions`,
    `  ${cmd('happier daemon stop --all')}            Stop daemons for all configured servers`,
    `  ${cmd('happier daemon status')}                Show daemon status`,
    `  ${cmd('happier daemon status --all')}          Show daemon status for all configured servers`,
    `  ${cmd('happier daemon list')}                  List active sessions`,
    `  ${cmd('happier daemon install')}               Legacy alias for ${cmd('happier service install')}`,
    `  ${cmd('happier daemon uninstall')}             Legacy alias for ${cmd('happier service uninstall')}`,
    `  ${cmd('happier daemon service')}               Legacy alias for ${cmd('happier service')}`,
    `  ${cmd('happier daemon service list')}          Legacy alias for ${cmd('happier service list')}`,
    '',
    '  Prefix with --server/--server-url to target a specific server profile for this invocation.',
    `  Canonical service command: ${cmd('happier service install')}`,
    `  Example: ${cmd('happier --server company service install')}`,
    '',
    `  If you want to kill all happier related processes run ${cmd('happier doctor clean')}`,
    '',
    `${sectionTitle('Note:')} The daemon runs in the background and manages Happier sessions.`,
    `${sectionTitle('To clean up runaway processes:')} Use ${cmd('happier doctor clean')}`,
    '',
  ].join('\n'));
}
