import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { configuration } from '@/configuration';
import { readDaemonState } from '@/persistence';
import { isBun } from '@/utils/runtime';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';

import { installDaemonService, uninstallDaemonService } from './installer';
import {
  planDaemonServiceInstall,
  planDaemonServiceLifecycle,
  planDaemonServiceUninstall,
  resolveLaunchAgentPlistPath,
  resolveSystemdUserUnitPath,
  resolveSystemdSystemUnitPath,
  resolveWindowsDaemonWrapperPath,
  resolveWindowsDaemonTaskName,
  resolveDaemonServiceLaunchdLabel,
  resolveDaemonServiceSystemdUnitName,
  type DaemonServiceMode,
} from './plan';
import { commandExistsInPath } from './commandExistsInPath';
import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';
import { resolveLinuxSystemUserPaths } from './resolveLinuxSystemUserPaths';

export type DaemonServiceCliAction =
  | 'paths'
  | 'install'
  | 'uninstall'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'logs'
  | 'tail';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

function resolveSupportedPlatform(p: string): SupportedPlatform | null {
  const normalized = (p ?? '').toString().trim().toLowerCase();
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos' || normalized === 'osx') return 'darwin';
  if (normalized === 'linux') return 'linux';
  if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') return 'win32';
  return null;
}

function resolvePlatformFromProcess(): SupportedPlatform | null {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return null;
}

function parseCliFlags(argv: readonly string[]): Readonly<{ json: boolean; dryRun: boolean; help: boolean }> {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  return {
    json: flags.has('--json'),
    dryRun: flags.has('--dry-run') || flags.has('--plan'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function resolveModeFromText(raw: string, source: string): DaemonServiceMode {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'user' || value === 'system') return value;
  throw new Error(`Invalid ${source} value "${String(raw ?? '').trim()}" (expected user|system)`);
}

function resolveOptionalModeFromText(raw: string, source: string): DaemonServiceMode | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return resolveModeFromText(value, source);
}

function parseDaemonServiceCliInvocation(argv: readonly string[]): Readonly<{
  argvFiltered: string[];
  flags: Readonly<{ json: boolean; dryRun: boolean; help: boolean }>;
  action: DaemonServiceCliAction;
  mode: DaemonServiceMode;
  systemUser: string;
}> {
  const filtered: string[] = [];
  let modeFromArgs: DaemonServiceMode | null = null;
  let systemUserFromArgs: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');

    if (a === '--mode') {
      const next = String(argv[i + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --mode (expected user|system)');
      }
      modeFromArgs = resolveModeFromText(next, '--mode');
      i += 1;
      continue;
    }
    if (a.startsWith('--mode=')) {
      modeFromArgs = resolveModeFromText(a.slice('--mode='.length), '--mode');
      continue;
    }
    if (a === '--system') {
      modeFromArgs = 'system';
      continue;
    }
    if (a === '--user') {
      modeFromArgs = 'user';
      continue;
    }

    if (a === '--system-user') {
      const next = String(argv[i + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --system-user');
      }
      systemUserFromArgs = next.trim();
      i += 1;
      continue;
    }
    if (a.startsWith('--system-user=')) {
      systemUserFromArgs = a.slice('--system-user='.length).trim();
      continue;
    }

    filtered.push(a);
  }

  const flags = parseCliFlags(filtered);
  const action = resolveAction(filtered);
  const mode = modeFromArgs ?? resolveOptionalModeFromText(process.env.HAPPIER_DAEMON_SERVICE_MODE ?? '', 'HAPPIER_DAEMON_SERVICE_MODE') ?? 'user';
  const systemUser = systemUserFromArgs ?? String(process.env.HAPPIER_DAEMON_SERVICE_SYSTEM_USER ?? '').trim();

  return { argvFiltered: filtered, flags, action, mode, systemUser };
}

function resolveAction(argv: readonly string[]): DaemonServiceCliAction {
  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const action = (positionals[0] ?? 'status').toString().trim();
  if (!action) return 'status';
  if (action === 'help') return 'status';
  return action as DaemonServiceCliAction;
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function runCommandCaptureBestEffort(command: Readonly<{ cmd: string; args: readonly string[] }>): { ok: boolean; out: string | null } {
  try {
    const res = spawnSync(command.cmd, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const ok = (res.status ?? 1) === 0;
    const out = (res.stdout ? String(res.stdout) : '') + (res.stderr ? String(res.stderr) : '');
    return { ok, out: out.trim() ? out : null };
  } catch {
    return { ok: false, out: null };
  }
}

function runCommandsBestEffort(commands: ReadonlyArray<Readonly<{ cmd: string; args: readonly string[] }>>): void {
  for (const command of commands) {
    if (!commandExistsInPath({ cmd: command.cmd, envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) continue;
    try {
      spawnSync(command.cmd, [...command.args], { stdio: 'ignore', env: process.env });
    } catch {
      // ignore
    }
  }
}

export type DaemonServiceCliRuntime = Readonly<{
  platform: SupportedPlatform;
  instanceId: string;
  uid: number | null;
  userHomeDir: string;
  happierHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  publicServerUrl: string;
  nodePath: string;
  entryPath: string;
}>;

export function resolveDaemonServiceCliRuntimeFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
}> = {}): DaemonServiceCliRuntime {
  const platform =
    resolveSupportedPlatform(process.env.HAPPIER_DAEMON_SERVICE_PLATFORM ?? '') ??
    resolvePlatformFromProcess();
  if (!platform) {
    throw new Error('Daemon service is currently only supported on macOS, Linux, and Windows');
  }

  const uidEnvRaw = (process.env.HAPPIER_DAEMON_SERVICE_UID ?? '').trim();
  const uidEnv = uidEnvRaw ? Number(uidEnvRaw) : null;
  const uidFromProc = process.getuid ? process.getuid() : null;
  const uid = uidEnv !== null && Number.isFinite(uidEnv) && uidEnv >= 0 ? uidEnv : uidFromProc;

  const explicitUserHomeDir = (process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR ?? '').trim();
  const explicitHappierHomeDir = (process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR ?? '').trim();
  const systemUserPaths =
    platform === 'linux' && options.mode === 'system' && String(options.systemUser ?? '').trim()
      ? resolveLinuxSystemUserPaths({
          systemUser: String(options.systemUser ?? '').trim(),
          userHomeDirOverride: explicitUserHomeDir,
          happierHomeDirOverride: explicitHappierHomeDir,
        })
      : null;

  const userHomeDir = systemUserPaths?.userHomeDir ?? (explicitUserHomeDir || homedir());
  const happierHomeDir = systemUserPaths?.happierHomeDir ?? (explicitHappierHomeDir || configuration.happyHomeDir);
  const instanceId = (process.env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? '').trim() || configuration.activeServerId;
  const serverUrl = (process.env.HAPPIER_DAEMON_SERVICE_SERVER_URL ?? '').trim() || configuration.serverUrl;
  const webappUrl = (process.env.HAPPIER_DAEMON_SERVICE_WEBAPP_URL ?? '').trim() || configuration.webappUrl;
  const publicServerUrl = (process.env.HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL ?? '').trim() || configuration.publicServerUrl;
  const explicitNodePath = (process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '').trim();
  const explicitEntryPath = (process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '').trim();
  const runtimeTarget = resolveDaemonServiceRuntimeTarget({
    currentExecPath: process.execPath,
    runtimeExecutable: explicitNodePath
      ? null
      : resolveJavaScriptRuntimeExecutable({
          isBunRuntime: isBun(),
          processEnv: process.env,
        }),
    explicitNodePath,
    explicitEntryPath,
  });

  return {
    platform,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
    serverUrl,
    webappUrl,
    publicServerUrl,
    nodePath: runtimeTarget.nodePath,
    entryPath: runtimeTarget.entryPath,
  };
}

export function resolveDaemonServicePaths(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode }> = {},
): Readonly<{
  platform: SupportedPlatform;
  label: string;
  unitName: string;
  plistPath: string;
  unitPath: string;
  wrapperPath: string;
  taskName: string;
  installedPath: string;
  stdoutPath: string;
  stderrPath: string;
}> {
  const mode: DaemonServiceMode = options.mode === 'system' ? 'system' : 'user';
  const label = resolveDaemonServiceLaunchdLabel(runtime.instanceId);
  const unitName = resolveDaemonServiceSystemdUnitName(runtime.instanceId);
  const plistPath = resolveLaunchAgentPlistPath({ userHomeDir: runtime.userHomeDir, instanceId: runtime.instanceId });
  const unitPath =
    runtime.platform === 'linux' && mode === 'system'
      ? resolveSystemdSystemUnitPath({ instanceId: runtime.instanceId })
      : resolveSystemdUserUnitPath({ userHomeDir: runtime.userHomeDir, instanceId: runtime.instanceId });
  const wrapperPath = runtime.platform === 'win32'
    ? resolveWindowsDaemonWrapperPath({ happierHomeDir: runtime.happierHomeDir, instanceId: runtime.instanceId })
    : '';
  const taskName = runtime.platform === 'win32'
    ? resolveWindowsDaemonTaskName({ instanceId: runtime.instanceId })
    : '';
  const installedPath = runtime.platform === 'darwin'
    ? plistPath
    : runtime.platform === 'linux'
      ? unitPath
      : wrapperPath;
  return {
    platform: runtime.platform,
    label,
    unitName,
    plistPath,
    unitPath,
    wrapperPath,
    taskName,
    installedPath,
    stdoutPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${runtime.instanceId}.out.log`),
    stderrPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${runtime.instanceId}.err.log`),
  };
}

export async function runDaemonServiceCliCommand(params: Readonly<{ argv: readonly string[] }>): Promise<void> {
  const parsed = parseDaemonServiceCliInvocation(params.argv);
  const flags = parsed.flags;
  const mode = parsed.mode;
  const systemUser = parsed.systemUser;
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ mode, systemUser });
  const paths = resolveDaemonServicePaths(runtime, { mode });
  const action = parsed.action;

  if (flags.help) {
    if (flags.json) {
      printJson({
        ok: true,
        commands: ['paths', 'install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'tail'],
        flags: ['--json', '--dry-run'],
      });
      return;
    }
    process.stdout.write(
      [
        'happier daemon service',
        '',
        'Usage:',
        '  happier daemon service paths [--json]',
        '  happier daemon service status [--json]',
        '  happier daemon service install [--dry-run] [--json]',
        '  happier daemon service uninstall [--dry-run] [--json]',
        '  happier daemon service start|stop|restart [--dry-run] [--json]',
        '  happier daemon service logs [--json]',
        '  happier daemon service tail',
        '',
      ].join('\n'),
    );
    return;
  }

  if (action === 'paths') {
    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        paths: runtime.platform === 'darwin'
          ? { plistPath: paths.plistPath, label: paths.label, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath }
          : runtime.platform === 'win32'
            ? { taskName: paths.taskName, wrapperPath: paths.wrapperPath, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath }
            : { unitPath: paths.unitPath, unitName: paths.unitName, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath },
      });
      return;
    }

    process.stdout.write(
      runtime.platform === 'darwin'
        ? `LaunchAgent: ${paths.plistPath}\nLabel: ${paths.label}\n`
        : runtime.platform === 'win32'
          ? `Scheduled Task: ${paths.taskName}\nWrapper: ${paths.wrapperPath}\n`
          : `systemd unit: ${paths.unitPath}\nUnit name: ${paths.unitName}\n`,
    );
    process.stdout.write(`stdout: ${paths.stdoutPath}\nstderr: ${paths.stderrPath}\n`);
    return;
  }

  if (action === 'install') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service install');
      }
      if (!systemUser) {
        throw new Error('Missing --system-user (required for system mode)');
      }
    }

    const plan = planDaemonServiceInstall({
      platform: runtime.platform,
      mode,
      systemUser,
      instanceId: runtime.instanceId,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      serverUrl: runtime.serverUrl,
      webappUrl: runtime.webappUrl,
      publicServerUrl: runtime.publicServerUrl,
      nodePath: runtime.nodePath,
      entryPath: runtime.entryPath,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, plan });
        return;
      }
      process.stdout.write(`[dry-run] would write: ${plan.files.map((f) => f.path).join(', ')}\n`);
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      return;
    }

    await installDaemonService({
      platform: runtime.platform,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      mode,
      systemUser,
      instanceId: runtime.instanceId,
      serverUrl: runtime.serverUrl,
      webappUrl: runtime.webappUrl,
      publicServerUrl: runtime.publicServerUrl,
      nodePath: runtime.nodePath,
      entryPath: runtime.entryPath,
      runCommands: true,
    });

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform });
      return;
    }
    process.stdout.write('Daemon service installed.\n');
    return;
  }

  if (action === 'uninstall') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service uninstall');
      }
    }

    const plan = planDaemonServiceUninstall({
      platform: runtime.platform,
      mode,
      instanceId: runtime.instanceId,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, plan });
        return;
      }
      process.stdout.write(`[dry-run] would remove: ${plan.filesToRemove.join(', ')}\n`);
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      return;
    }

    await uninstallDaemonService({
      platform: runtime.platform,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      mode,
      instanceId: runtime.instanceId,
      runCommands: true,
    });

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform });
      return;
    }
    process.stdout.write('Daemon service uninstalled.\n');
    return;
  }

  if (action === 'start' || action === 'stop' || action === 'restart') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service lifecycle actions');
      }
    }

    if (!existsSync(paths.installedPath)) {
      const msg = `Daemon service is not installed (${paths.installedPath}). Run: happier daemon service install`;
      if (flags.json) printJson({ ok: false, error: 'not_installed', message: msg, platform: runtime.platform });
      else process.stderr.write(`${msg}\n`);
      return;
    }

    const plan = planDaemonServiceLifecycle({
      platform: runtime.platform,
      action,
      mode,
      instanceId: runtime.instanceId,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      uid: runtime.uid ?? undefined,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, plan });
        return;
      }
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      return;
    }

    runCommandsBestEffort(plan.commands);

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform });
      return;
    }
    process.stdout.write(`Daemon service ${action} requested.\n`);
    return;
  }

  if (action === 'status') {
    const installed = existsSync(paths.installedPath);

    const state = await readDaemonState().catch(() => null);
    const pid = typeof state?.pid === 'number' ? state.pid : null;
    const pidAlive = (() => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    const systemPlan = planDaemonServiceLifecycle({
      platform: runtime.platform,
      action: 'status',
      mode,
      instanceId: runtime.instanceId,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      uid: runtime.uid ?? undefined,
    });

    const systemStatus = installed && !flags.dryRun && systemPlan.commands.length
      ? runCommandCaptureBestEffort(systemPlan.commands[0]!)
      : { ok: false, out: null };

    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        installed,
        installedPath: paths.installedPath,
        daemon: pid ? { pid, running: pidAlive, startedAt: state?.startedAt ?? null } : { pid: null, running: false, startedAt: null },
        system: { ok: systemStatus.ok, output: systemStatus.out },
      });
      return;
    }

    process.stdout.write(installed ? 'Service: installed\n' : 'Service: not installed\n');
    process.stdout.write(pidAlive ? `Daemon: running (pid ${pid})\n` : 'Daemon: not running\n');
    if (systemStatus.out) process.stdout.write(`\n${systemStatus.out}\n`);
    return;
  }

  if (action === 'logs') {
    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform, logs: { stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath } });
      return;
    }
    process.stdout.write(`${paths.stdoutPath}\n${paths.stderrPath}\n`);
    return;
  }

  if (action === 'tail') {
    if (flags.json) {
      printJson({ ok: false, error: 'not_supported', message: 'tail is interactive; omit --json', platform: runtime.platform });
      return;
    }
    if (runtime.platform === 'win32') {
      process.stderr.write('tail is not supported on Windows yet. Use: happier daemon service logs\n');
      return;
    }
    // Best-effort: follow both stdout + stderr if tail exists.
    if (!commandExistsInPath({ cmd: 'tail', envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) {
      process.stderr.write('tail not found on PATH\n');
      return;
    }
    spawnSync('tail', ['-n', '200', '-f', paths.stdoutPath, paths.stderrPath], { stdio: 'inherit', env: process.env });
    return;
  }

  const msg = `Unknown daemon service subcommand: ${action}`;
  if (flags.json) printJson({ ok: false, error: 'invalid_subcommand', message: msg });
  else process.stderr.write(`${msg}\n`);
}
