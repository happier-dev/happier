import { createServerUrlComparableKey, type RestartSessionRunnerResultV1 } from '@happier-dev/protocol';

import {
  checkIfDaemonRunningAndCleanupStaleState,
  inspectDaemonRunningStateAndCleanupStaleState,
  listDaemonSessions,
  requestDaemonSessionRunnerRestart,
  restartAllDaemonSessionRunners,
  stopDaemon,
  stopDaemonSession,
} from '@/daemon/controlClient';
import type { DaemonSessionRunnerRestartMode, RestartAllDaemonSessionRunnersResult } from '@/daemon/controlClient';
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
import { readDaemonStartWaitPollMs, readDaemonStartWaitTimeoutMs } from '@/daemon/startupWaitDefaults';
import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';
import { handleServiceRepairCliCommand } from './service/repair/handleServiceRepairCliCommand';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { renderDaemonOwnerConflict } from '@/daemon/ownership/renderDaemonOwnerConflict';
import {
  buildDaemonTakeoverNotice,
  resolveDaemonTakeoverDecision,
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

function isHelpFlag(value: unknown): boolean {
  return value === '--help' || value === '-h';
}

function shouldPrintDaemonHelp(args: readonly string[]): boolean {
  return args.slice(1).some(isHelpFlag);
}

type DaemonSessionIdOption =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present'; sessionId: string }>
  | Readonly<{ kind: 'invalid'; message: string }>;

function parseDaemonSessionIdOption(args: readonly string[]): DaemonSessionIdOption {
  const index = args.indexOf('--session-id');
  if (index < 0) return { kind: 'absent' };
  const value = args[index + 1];
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('-')) {
    return {
      kind: 'invalid',
      message: 'Session id is required after --session-id.',
    };
  }
  return { kind: 'present', sessionId: value.trim() };
}

function parseDaemonSessionRunnerRestartMode(args: readonly string[]): DaemonSessionRunnerRestartMode {
  if (args.includes('--force-current-cli')) return 'force_current_cli';
  return 'if_stale';
}

function printRestartAllSessionRunnersText(result: RestartAllDaemonSessionRunnersResult): void {
  console.log(ok('Session runner restart request completed'));
  console.log(`  ${kv('Requested:', String(result.requestedCount))}`);
  console.log(`  ${kv('Restarted:', String(result.restartedCount))}`);
  console.log(`  ${kv('Skipped:', String(result.skippedCount))}`);
  console.log(`  ${kv('Failed:', String(result.failedCount))}`);
}

function formatSessionRunnerRestartResultLine(result: RestartSessionRunnerResultV1): string {
  const reason = result.ok ? null : result.reasonCode;
  return `${result.sessionId}: ${result.status}${reason ? ` (${reason})` : ''}`;
}

function printRestartAllSessionRunnersFailureAfterDaemonRestart(result: RestartAllDaemonSessionRunnersResult): void {
  console.error(errorFrame('Session runner restart failed after daemon restart', [
    `${kv('Session runners:', `${result.restartedCount} restarted, ` +
      `${result.skippedCount} skipped, ${result.failedCount} failed`)}`,
    ...result.results.map(formatSessionRunnerRestartResultLine),
  ]));
}

function printDaemonHelp(): void {
  console.log([
    `${sectionTitle('happier daemon')} - Daemon management`,
    '',
    sectionTitle('Usage:'),
    `  ${cmd('happier daemon start')}                 Start the daemon (detached)`,
    `  ${cmd('happier daemon start --takeover')}      Start and take over an existing manual relay runtime`,
    `  ${cmd('happier daemon restart')}               Restart the daemon (stop → start)`,
    `  ${cmd('happier daemon restart --restart-session-runners')}  Restart the daemon, then refresh daemon-started session runners`,
    `  ${cmd('happier daemon restart-session-runners')}  Refresh stale daemon-started session runners`,
    `  ${cmd('happier daemon stop')}                  Stop a manual daemon (sessions stay alive; use happier service stop for installed background services)`,
    `  ${cmd('happier daemon stop --kill-sessions')}  Stop a manual daemon and its tracked sessions`,
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
    '  For installed background services, use happier service start|stop|restart.',
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

  if (daemonSubcommand === 'voice-inference-worker') {
    // Hidden subcommand: this process IS the forked voice-inference worker child. The daemon
    // spawns it via spawnHappyCLI (binary-safe) and drives it over stdio. It must not print
    // help, attach to the relay, or run any daemon control logic — just host the engine.
    const { runVoiceInferenceWorkerChild } = await import('@/daemon/voiceInference/forkedWorker/workerEntry');
    await runVoiceInferenceWorkerChild();
    process.exit(0);
  }

  if (daemonSubcommand === 'plugin-packed-test-host') {
    // Hidden restricted daemon mode used only by the public packed-author flow.
    // It hosts the production G3 plugin owner over authenticated loopback HTTP.
    const { runPackedTestDaemonHost } = await import('@/plugins/daemon/packedTestHost');
    await runPackedTestDaemonHost(args.slice(2));
    process.exit(0);
  }

  if (shouldPrintDaemonHelp(args)) {
    printDaemonHelp();
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
      const result = await stopDaemonSession(sessionId);
      console.log(result.status === 'stopped' ? ok('Session stopped') : warn('Failed to stop session'));
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
    const takeoverDecision = resolveDaemonTakeoverDecision({
      ownership,
      takeoverRequested,
      startupSource,
    });

    if (takeoverDecision.kind === 'conflict') {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-start',
        owner: takeoverDecision.owner,
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

    if (takeoverDecision.kind === 'manual-owner-takeover' && !jsonRequested) {
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

    const timeoutMs = readDaemonStartWaitTimeoutMs();
    const pollMs = readDaemonStartWaitPollMs();
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
      const inspection = await inspectDaemonRunningStateAndCleanupStaleState().catch(() => ({ status: 'not-running' as const }));
      const latestDaemonLog = await getLatestDaemonLog().catch(() => null);
      if (inspection.status === 'starting') {
        if (jsonRequested) {
          printDaemonJson({
            ok: true,
            status: 'starting',
            relay: configuration.serverUrl,
            relayId: configuration.activeServerId,
            ...(latestDaemonLog?.path ? { latestDaemonLogPath: latestDaemonLog.path } : {}),
          });
        } else {
          console.log(warn('Daemon is still starting in the background'));
          console.log(`  ${kv('Relay:', configuration.serverUrl)}`);
          console.log(`  ${kv('Relay ID:', configuration.activeServerId)}`);
          if (latestDaemonLog?.path) {
            console.log(`  ${kv('Latest daemon log:', latestDaemonLog.path)}`);
          }
        }
        process.exit(0);
      }

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
    if (ownership.kind === 'compatible' && startupSource !== 'self-restart') {
      console.log(ok('Daemon already running'));
      console.log(`  ${kv('Relay:', configuration.serverUrl)}`);
      console.log(`  ${kv('Relay ID:', configuration.activeServerId)}`);
      process.exit(0);
    }
    const takeoverDecision = resolveDaemonTakeoverDecision({
      ownership,
      takeoverRequested,
      startupSource,
    });

    if (takeoverDecision.kind === 'conflict') {
      const message = renderDaemonOwnerConflict({
        intent: 'daemon-start-sync',
        owner: takeoverDecision.owner,
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

    if (takeoverDecision.kind === 'manual-owner-takeover') {
      console.log(warn('Taking over the current manual relay runtime before starting a new relay...'));
    }

    await startDaemon({ takeover: takeoverRequested });
    process.exit(0);
  }

  if (daemonSubcommand === 'stop') {
    const stopSessions = args.includes('--kill-sessions');
    const transferManagedLocalServices = args.includes('--transfer-managed-local-services');
    if (stopSessions && transferManagedLocalServices) {
      console.error(errorFrame('Error:', [
        '`happier daemon stop --transfer-managed-local-services` cannot be combined with `--kill-sessions`.',
      ]));
      process.exit(1);
    }
    const stopOptions = transferManagedLocalServices
      ? { transferManagedLocalServices: true as const }
      : { stopSessions };
    if (args.includes('--all')) {
      await stopAllDaemonsBestEffort(stopOptions);
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
    await stopDaemon(stopOptions);
    process.exit(0);
  }

  if (daemonSubcommand === 'restart-session-runners') {
    const jsonRequested = args.includes('--json');
    const dryRun = args.includes('--dry-run');
    const mode = parseDaemonSessionRunnerRestartMode(args);
    const sessionIdOption = parseDaemonSessionIdOption(args);
    if (sessionIdOption.kind === 'invalid') {
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'session_id_required',
          message: sessionIdOption.message,
        });
      } else {
        console.error(errorFrame('Missing session id', [sessionIdOption.message]));
      }
      process.exit(1);
    }
    const sessionId = sessionIdOption.kind === 'present' ? sessionIdOption.sessionId : null;

    try {
      if (sessionId) {
        const result = await requestDaemonSessionRunnerRestart({
          sessionId,
          mode,
          dryRun,
          reason: 'daemon_restart_session_runners_command',
        });
        if (jsonRequested) {
          printDaemonJson({ kind: 'single', result });
        } else {
          console.log(ok(`Session runner restart request completed (${result.status})`));
        }
      } else {
        const result = await restartAllDaemonSessionRunners({
          mode,
          dryRun,
          reason: 'daemon_restart_session_runners_command',
        });
        if (jsonRequested) {
          printDaemonJson({ kind: 'bulk', result });
        } else {
          printRestartAllSessionRunnersText(result);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restart session runners';
      if (jsonRequested) {
        printDaemonJson({ ok: false, error: 'restart_session_runners_failed', message });
      } else {
        console.error(errorFrame('Failed to restart session runners', [message]));
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'restart') {
    const jsonRequested = args.includes('--json');
    const restartSessionRunners = args.includes('--restart-session-runners');
    const stopSessions = args.includes('--kill-sessions');
    if (restartSessionRunners && stopSessions) {
      const message = '`happier daemon restart --restart-session-runners` cannot be combined with `--kill-sessions`.';
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'restart_session_runners_kill_sessions_conflict',
          message,
        });
      } else {
        console.error(errorFrame('Error:', [message]));
      }
      process.exit(1);
    }
    if (args.includes('--all')) {
      const message = '`happier daemon restart --all` is not supported yet.';
      if (jsonRequested) {
        printDaemonJson({
          ok: false,
          error: 'restart_all_unsupported',
          message,
        });
      } else {
        console.error(errorFrame('Error:', [message]));
      }
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

    const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
    const startupSourceForServiceConflict = startupSource === 'self-restart'
      ? 'manual'
      : startupSource;
    if (!isDaemonStartupSourceServiceManaged(startupSourceForServiceConflict)) {
      const serviceRuntime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
      const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
        startupSource: startupSourceForServiceConflict,
        runtime: serviceRuntime,
      });
      if (startupServiceConflict.kind === 'installed-background-service-conflict') {
        const message = renderDaemonInstalledServiceConflict({
          action: 'daemon-restart',
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
      const notice = buildDaemonTakeoverNotice({ action: 'restart' });
      console.log(warn(notice.title));
      for (const line of notice.lines) {
        console.log(`  ${line}`);
      }
    }

    const restartResult = await restartDaemonAndWait({
      stopSessions,
      takeover: takeoverRequested,
      ...(restartSessionRunners
        ? {
          restartSessionRunners: true,
          restartSessionRunnersMode: 'force_current_cli' as const,
        }
        : {}),
    });
    const started = typeof restartResult === 'boolean' ? restartResult : restartResult.ok;
    const sessionRunnerRestart = typeof restartResult === 'boolean'
      ? undefined
      : restartResult.sessionRunnerRestart;

    if (started) {
      if (jsonRequested) {
        printDaemonJson({
          ok: true,
          status: 'restarted',
          relay: configuration.serverUrl,
          relayId: configuration.activeServerId,
          ...(sessionRunnerRestart ? { sessionRunnerRestart } : {}),
        });
      } else {
        console.log(ok('Daemon restarted successfully'));
        console.log(`  ${kv('Relay:', configuration.serverUrl)}`);
        console.log(`  ${kv('Relay ID:', configuration.activeServerId)}`);
        if (sessionRunnerRestart) {
          console.log(
            `  ${kv('Session runners:', `${sessionRunnerRestart.restartedCount} restarted, ` +
              `${sessionRunnerRestart.skippedCount} skipped, ${sessionRunnerRestart.failedCount} failed`)}`,
          );
        }
      }
      process.exit(0);
    }

    const latestDaemonLog = sessionRunnerRestart
      ? null
      : await getLatestDaemonLog().catch(() => null);
    const failureMessage = sessionRunnerRestart
      ? 'Session runner restart failed after daemon restart'
      : 'Failed to restart daemon';
    if (jsonRequested) {
      printDaemonJson({
        ok: false,
        error: sessionRunnerRestart ? 'session_runner_restart_failed_after_daemon_restart' : 'restart_failed',
        message: failureMessage,
        relay: configuration.serverUrl,
        relayId: configuration.activeServerId,
        ...(sessionRunnerRestart ? { sessionRunnerRestart } : {}),
        ...(latestDaemonLog?.path ? { latestDaemonLogPath: latestDaemonLog.path } : {}),
      });
    } else {
      if (sessionRunnerRestart) {
        printRestartAllSessionRunnersFailureAfterDaemonRestart(sessionRunnerRestart);
      } else {
        console.error(errorFrame(failureMessage, []));
      }
      if (!sessionRunnerRestart && latestDaemonLog?.path) {
        console.error(`  ${kv('Latest daemon log:', latestDaemonLog.path)}`);
      }
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

  printDaemonHelp();
}
