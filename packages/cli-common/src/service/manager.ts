import { dirname, join } from 'node:path';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { SpawnSyncReturns } from 'node:child_process';
import { spawnBackgroundSync } from '../process/spawnBackgroundSync.js';
import { userInfo } from 'node:os';

import { commandExistsOnPath } from '../process/index.js';
import { buildLaunchdPlistXml } from './launchd.js';
import { mergeServiceEnvWithPath } from './path.js';
import { renderSystemdServiceUnit } from './systemd.js';
import {
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  buildRegisterWindowsUserScheduledTaskPowerShellCommand,
  buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand,
  buildSetWindowsScheduledTaskEnabledPowerShellCommand,
  buildApplyWindowsScheduledTaskServicePolicyPowerShellCommand,
  buildStopWindowsScheduledTaskIfRunningPowerShellCommand,
  buildWindowsScheduledTaskPowerShellAction,
  parseWindowsScheduledTaskStatusPowerShellJson,
  renderWindowsScheduledTaskWrapperPs1,
  splitQualifiedWindowsScheduledTaskName,
} from './windows.js';

export type ServiceMode = 'user' | 'system';

export type ServiceBackend =
  | 'systemd-user'
  | 'systemd-system'
  | 'launchd-user'
  | 'launchd-system'
  | 'schtasks-user'
  | 'schtasks-system';

export type ServiceSpec = Readonly<{
  label: string;
  description?: string;
  programArgs: readonly string[];
  workingDirectory?: string;
  env?: Record<string, string>;
  runAsUser?: string;
  stdoutPath?: string;
  stderrPath?: string;
  restartPolicy?: 'always' | 'on-failure' | 'no';
}>;

export type ServiceDefinition = Readonly<{
  kind: 'systemd-service' | 'launchd-plist' | 'windows-wrapper-ps1';
  path: string;
  contents: string;
  mode: number;
}>;

export type PlannedWrite = Readonly<{ path: string; contents: string; mode?: number }>;
export type PlannedCommand = Readonly<{
  cmd: string;
  args: readonly string[];
  allowFail?: boolean;
  expectedFailure?: 'service-absent';
  completePlanOnExpectedFailure?: boolean;
  fallbackCommands?: readonly PlannedCommand[];
}>;
export type ServiceDefinitionRemoval = Readonly<{ path: string; beforeCommandIndex: number }>;
export type ServicePlan = Readonly<{
  writes: PlannedWrite[];
  commands: PlannedCommand[];
  removals?: readonly ServiceDefinitionRemoval[];
}>;
export type ServiceRegistrationState = 'registered' | 'absent';

function windowsPowerShellCommandArgs(command: string): readonly string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
}

export function resolveServiceBackend(params: Readonly<{ platform?: NodeJS.Platform; mode?: ServiceMode }> = {}): ServiceBackend {
  const p = String(params.platform ?? '').trim() || process.platform;
  const m: ServiceMode = String(params.mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';

  if (p === 'darwin') return m === 'system' ? 'launchd-system' : 'launchd-user';
  if (p === 'linux') return m === 'system' ? 'systemd-system' : 'systemd-user';
  if (p === 'win32') return m === 'system' ? 'schtasks-system' : 'schtasks-user';
  throw new Error(`Unsupported platform: ${p}`);
}

function normalizeSpec(spec: ServiceSpec): Required<ServiceSpec> {
  const label = String(spec?.label ?? '').trim();
  if (!label) throw new Error('Service label is required');
  const programArgs = Array.isArray(spec?.programArgs) ? spec.programArgs.map((a) => String(a ?? '')).filter(Boolean) : [];
  if (programArgs.length === 0) throw new Error('Service programArgs are required');
  return {
    label,
    description: String(spec?.description ?? '').trim() || label,
    programArgs,
    workingDirectory: String(spec?.workingDirectory ?? '').trim(),
    env: spec?.env ?? {},
    runAsUser: String(spec?.runAsUser ?? '').trim(),
    stdoutPath: String(spec?.stdoutPath ?? '').trim(),
    stderrPath: String(spec?.stderrPath ?? '').trim(),
    restartPolicy: spec?.restartPolicy ?? 'always',
  };
}

function systemdUnitPathForLabel(params: Readonly<{ homeDir: string; label: string; mode: ServiceMode }>): string {
  const unit = `${params.label}.service`;
  if (params.mode === 'system') return join('/etc/systemd/system', unit);
  return join(String(params.homeDir ?? '').trim() || '', '.config', 'systemd', 'user', unit);
}

function launchdPlistPathForLabel(params: Readonly<{ homeDir: string; label: string; mode: ServiceMode }>): string {
  const dir = params.mode === 'system'
    ? '/Library/LaunchDaemons'
    : join(String(params.homeDir ?? '').trim() || '', 'Library', 'LaunchAgents');
  return join(dir, `${params.label}.plist`);
}

function windowsWrapperPathForLabel(params: Readonly<{ homeDir: string; label: string; mode: ServiceMode }>): string {
  const base = String(params.homeDir ?? '').trim() || 'C:\\Users\\Default';
  if (params.mode === 'system') {
    return `C:\\ProgramData\\happier\\services\\${params.label}.ps1`;
  }
  return `${base}\\.happier\\services\\${params.label}.ps1`;
}

export function resolveServiceDefinitionPath(params: Readonly<{
  platform?: NodeJS.Platform;
  mode?: ServiceMode;
  homeDir: string;
  label: string;
}>): string {
  const backend = resolveServiceBackend({ platform: params.platform, mode: params.mode });
  const mode: ServiceMode = backend.endsWith('-system') ? 'system' : 'user';
  if (backend === 'systemd-user' || backend === 'systemd-system') {
    return systemdUnitPathForLabel({ homeDir: params.homeDir, label: params.label, mode });
  }
  if (backend === 'launchd-user' || backend === 'launchd-system') {
    return launchdPlistPathForLabel({ homeDir: params.homeDir, label: params.label, mode });
  }
  return windowsWrapperPathForLabel({ homeDir: params.homeDir, label: params.label, mode });
}

export function buildServiceDefinition(params: Readonly<{ backend: ServiceBackend; homeDir: string; spec: ServiceSpec }>): ServiceDefinition {
  const s = normalizeSpec(params.spec);
  const backend = String(params.backend ?? '').trim() as ServiceBackend;
  const platform: NodeJS.Platform =
    backend === 'launchd-user' || backend === 'launchd-system'
      ? 'darwin'
      : backend === 'systemd-user' || backend === 'systemd-system'
        ? 'linux'
        : 'win32';
  const mergedEnv = mergeServiceEnvWithPath({
    env: s.env,
    execPath: s.programArgs[0],
    basePath: process.env.PATH,
    homeDir: params.homeDir,
    platform,
  });

  if (backend === 'systemd-user' || backend === 'systemd-system') {
    const mode: ServiceMode = backend === 'systemd-system' ? 'system' : 'user';
    const path = resolveServiceDefinitionPath({ platform: 'linux', mode, homeDir: params.homeDir, label: s.label });
    const contents = renderSystemdServiceUnit({
      description: s.description,
      execStart: s.programArgs,
      workingDirectory: s.workingDirectory,
      env: mergedEnv,
      restart: s.restartPolicy,
      runAsUser: s.runAsUser,
      stdoutPath: s.stdoutPath,
      stderrPath: s.stderrPath,
      wantedBy: mode === 'system' ? 'multi-user.target' : 'default.target',
    });
    return { kind: 'systemd-service', path, contents, mode: 0o644 };
  }

  if (backend === 'launchd-user' || backend === 'launchd-system') {
    const mode: ServiceMode = backend === 'launchd-system' ? 'system' : 'user';
    const path = resolveServiceDefinitionPath({ platform: 'darwin', mode, homeDir: params.homeDir, label: s.label });
    const contents = buildLaunchdPlistXml({
      label: s.label,
      programArgs: s.programArgs,
      env: mergedEnv,
      stdoutPath: s.stdoutPath || (mode === 'system' ? `/var/log/${s.label}.out.log` : join(String(params.homeDir ?? '').trim() || '', '.happier', 'logs', `${s.label}.out.log`)),
      stderrPath: s.stderrPath || (mode === 'system' ? `/var/log/${s.label}.err.log` : join(String(params.homeDir ?? '').trim() || '', '.happier', 'logs', `${s.label}.err.log`)),
      workingDirectory: s.workingDirectory,
      keepAliveOnFailure: true,
    });
    return { kind: 'launchd-plist', path, contents, mode: 0o644 };
  }

  if (backend === 'schtasks-user' || backend === 'schtasks-system') {
    const mode: ServiceMode = backend === 'schtasks-system' ? 'system' : 'user';
    const path = resolveServiceDefinitionPath({ platform: 'win32', mode, homeDir: params.homeDir, label: s.label });
    const contents = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: s.workingDirectory,
      programArgs: s.programArgs,
      env: mergedEnv,
      stdoutPath: s.stdoutPath,
      stderrPath: s.stderrPath,
    });
    return { kind: 'windows-wrapper-ps1', path, contents, mode: 0o644 };
  }

  throw new Error(`Unsupported backend: ${backend}`);
}

function resolveUid(uid: number | null | undefined): number | null {
  if (typeof uid === 'number' && Number.isFinite(uid) && uid >= 0) return Math.floor(uid);
  if (typeof process.getuid === 'function') {
    const currentUid = process.getuid();
    if (currentUid === 0) {
      const sudoUid = Number(String(process.env.SUDO_UID ?? '').trim());
      if (Number.isFinite(sudoUid) && sudoUid > 0) {
        return Math.floor(sudoUid);
      }
    }
    return currentUid;
  }
  try {
    const info = userInfo();
    if (typeof info?.uid === 'number' && Number.isFinite(info.uid) && info.uid >= 0) return Math.floor(info.uid);
  } catch {
    // ignore
  }
  const envUid = Number(String(process.env.UID ?? '').trim());
  if (Number.isFinite(envUid) && envUid >= 0) return Math.floor(envUid);
  return null;
}

export function buildServiceCommandEnv(params: Readonly<{
  cmd: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  uid?: number | null;
}>): NodeJS.ProcessEnv {
  const env = { ...(params.env ?? process.env) };
  if (params.cmd !== 'systemctl' || !Array.isArray(params.args) || !params.args.includes('--user')) {
    return env;
  }

  const resolvedUid = resolveUid(params.uid);
  const runtimeDir = String(env.XDG_RUNTIME_DIR ?? '').trim() || (resolvedUid != null ? `/run/user/${resolvedUid}` : '');
  if (runtimeDir) {
    env.XDG_RUNTIME_DIR = runtimeDir;
    if (!String(env.DBUS_SESSION_BUS_ADDRESS ?? '').trim()) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
    }
  }
  return env;
}

export function planServiceAction(params: Readonly<{
  backend: ServiceBackend;
  action: 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'quarantine' | 'activate';
  label: string;
  definitionPath?: string;
  definitionContents?: string;
  taskName?: string;
  persistent?: boolean;
  uid?: number | null;
  restartPolicy?: 'always' | 'on-failure' | 'no';
}>): ServicePlan {
  const backend = String(params.backend ?? '').trim() as ServiceBackend;
  const action = String(params.action ?? '').trim();
  const label = String(params.label ?? '').trim();
  const definitionPath = String(params.definitionPath ?? '').trim();
  const contents = String(params.definitionContents ?? '');
  const taskName = String(params.taskName ?? '').trim();
  const persistent = params.persistent !== false;
  const uid = resolveUid(params.uid);

  if (!backend) throw new Error('backend is required');
  if (!action) throw new Error('action is required');
  if (!label) throw new Error('label is required');
  if (action === 'uninstall' && !definitionPath) throw new Error('definitionPath is required for uninstall');

  const writes: PlannedWrite[] = [];
  const commands: PlannedCommand[] = [];

  if (action === 'install' || ((action === 'start' || action === 'restart') && contents)) {
    if (!definitionPath) throw new Error('definitionPath is required for install');
    writes.push({ path: definitionPath, contents, mode: 0o644 });
  }

  if (backend === 'systemd-user' || backend === 'systemd-system') {
    const prefix = backend === 'systemd-user' ? ['--user'] : [];
    const unitName = `${label}.service`;
    if (action === 'install') {
      commands.push({ cmd: 'systemctl', args: [...prefix, 'daemon-reload'] });
      if (persistent) {
        commands.push({ cmd: 'systemctl', args: [...prefix, 'enable', unitName] });
      }
      // Always restart after install so updated unit/env changes take effect even when the service is already running.
      // `systemctl enable --now` does not restart existing services.
      commands.push({ cmd: 'systemctl', args: [...prefix, 'restart', unitName] });
      return { writes, commands };
    }
    if (action === 'uninstall') {
      commands.push({
        cmd: 'systemctl',
        args: [...prefix, 'disable', '--now', unitName],
        expectedFailure: 'service-absent',
      });
      commands.push({ cmd: 'systemctl', args: [...prefix, 'daemon-reload'] });
      return { writes, commands, removals: [{ path: definitionPath, beforeCommandIndex: 1 }] };
    }
    if (action === 'start') {
      if (writes.length > 0) commands.push({ cmd: 'systemctl', args: [...prefix, 'daemon-reload'] });
      commands.push({ cmd: 'systemctl', args: persistent ? [...prefix, 'enable', '--now', unitName] : [...prefix, 'start', unitName] });
      return { writes, commands };
    }
    if (action === 'stop') {
      commands.push({ cmd: 'systemctl', args: persistent ? [...prefix, 'disable', '--now', unitName] : [...prefix, 'stop', unitName], allowFail: true });
      return { writes, commands };
    }
    if (action === 'quarantine') {
      commands.push({ cmd: 'systemctl', args: [...prefix, 'disable', '--now', unitName], allowFail: true });
      return { writes, commands };
    }
    if (action === 'activate') {
      commands.push({ cmd: 'systemctl', args: [...prefix, 'enable', '--now', unitName] });
      return { writes, commands };
    }
    if (action === 'restart') {
      if (writes.length > 0) commands.push({ cmd: 'systemctl', args: [...prefix, 'daemon-reload'] });
      commands.push({ cmd: 'systemctl', args: [...prefix, 'restart', unitName] });
      return { writes, commands };
    }
  }

  if (backend === 'launchd-user' || backend === 'launchd-system') {
    if (!definitionPath) throw new Error('definitionPath is required for launchd operations');

    const preferBootstrap = backend === 'launchd-user' && uid != null && uid > 0;
    const bootstrapDomain = backend === 'launchd-system' ? 'system' : preferBootstrap ? `gui/${uid}` : null;
    const serviceDomain = bootstrapDomain ? `${bootstrapDomain}/${label}` : null;
    const bootstrapCommands = bootstrapDomain && serviceDomain
      ? [
          { cmd: 'launchctl', args: ['bootout', serviceDomain], allowFail: true },
          { cmd: 'launchctl', args: ['bootstrap', bootstrapDomain, definitionPath] },
          { cmd: 'launchctl', args: ['enable', serviceDomain] },
          { cmd: 'launchctl', args: ['kickstart', '-k', serviceDomain] },
        ] satisfies PlannedCommand[]
      : null;
    if (action === 'install' || action === 'start' || action === 'activate') {
      if (bootstrapCommands) {
        commands.push(...bootstrapCommands);
      } else {
        if (action === 'install') {
          commands.push({ cmd: 'launchctl', args: persistent ? ['unload', '-w', definitionPath] : ['unload', definitionPath], allowFail: true });
        }
        commands.push({ cmd: 'launchctl', args: persistent ? ['load', '-w', definitionPath] : ['load', definitionPath] });
      }
      return { writes, commands };
    }
    if (action === 'uninstall' || action === 'stop' || action === 'quarantine') {
      if (bootstrapDomain && serviceDomain) {
        if (action === 'uninstall') {
          commands.push({ cmd: 'launchctl', args: ['bootout', serviceDomain], expectedFailure: 'service-absent' });
          commands.push({ cmd: 'launchctl', args: ['disable', serviceDomain], expectedFailure: 'service-absent' });
        } else if (action === 'quarantine') {
          commands.push({ cmd: 'launchctl', args: ['disable', serviceDomain], allowFail: true });
          commands.push({ cmd: 'launchctl', args: ['bootout', bootstrapDomain, definitionPath], allowFail: true });
          commands.push({ cmd: 'launchctl', args: ['remove', label], allowFail: true });
        } else {
          commands.push({ cmd: 'launchctl', args: ['bootout', serviceDomain], allowFail: true });
        }
      } else {
        commands.push({
          cmd: 'launchctl',
          args: action === 'quarantine' || persistent ? ['unload', '-w', definitionPath] : ['unload', definitionPath],
          ...(action === 'uninstall' ? { expectedFailure: 'service-absent' as const } : { allowFail: true }),
        });
      }
      return action === 'uninstall'
        ? { writes, commands, removals: [{ path: definitionPath, beforeCommandIndex: commands.length }] }
        : { writes, commands };
    }
    if (action === 'restart') {
      if (bootstrapCommands && serviceDomain) {
        commands.push({
          cmd: 'launchctl',
          args: ['kickstart', '-k', serviceDomain],
          fallbackCommands: bootstrapCommands,
        });
      } else {
        commands.push({ cmd: 'launchctl', args: persistent ? ['unload', '-w', definitionPath] : ['unload', definitionPath], allowFail: true });
        commands.push({ cmd: 'launchctl', args: persistent ? ['load', '-w', definitionPath] : ['load', definitionPath] });
      }
      return { writes, commands };
    }
  }

  if (backend === 'schtasks-user' || backend === 'schtasks-system') {
    const name = taskName || `Happier\\${label}`;
    if (action !== 'start' && !definitionPath) {
      throw new Error(`definitionPath is required for schtasks ${action}`);
    }
    const stopIfRunning = (): PlannedCommand => ({
      cmd: 'powershell.exe',
      args: windowsPowerShellCommandArgs(buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
        qualifiedTaskName: name,
        definitionPath,
      })),
    });
    const mode: ServiceMode = backend === 'schtasks-system' ? 'system' : 'user';
    const setEnabled = (enabled: boolean): PlannedCommand => ({
      cmd: 'powershell.exe',
      args: windowsPowerShellCommandArgs(buildSetWindowsScheduledTaskEnabledPowerShellCommand({
        qualifiedTaskName: name,
        enabled,
      })),
    });
    if (action === 'install') {
      if (!definitionPath) throw new Error('definitionPath is required for schtasks install');
      const ps = buildWindowsScheduledTaskPowerShellAction({ definitionPath });
      const schedule = persistent ? 'ONSTART' : 'ONCE';
      const args = [
        '/Create',
        '/F',
        '/SC',
        schedule,
        ...(schedule === 'ONCE' ? ['/ST', '00:00'] : []),
        '/TN',
        name,
        '/TR',
        ps,
        ...(mode === 'system' ? ['/RU', 'SYSTEM', '/RL', 'HIGHEST'] : []),
      ];
      commands.push(stopIfRunning());
      commands.push(mode === 'user'
        ? {
          cmd: 'powershell.exe',
          args: windowsPowerShellCommandArgs(buildRegisterWindowsUserScheduledTaskPowerShellCommand({
            qualifiedTaskName: name, definitionPath, persistent,
          })),
        }
        : { cmd: 'schtasks', args });
      // schtasks has no restart/keep-alive switch, so the policy is applied to the
      // created task before it is first started.
      commands.push({
        cmd: 'powershell.exe',
        args: windowsPowerShellCommandArgs(buildApplyWindowsScheduledTaskServicePolicyPowerShellCommand({
          qualifiedTaskName: name,
          restartPolicy: params.restartPolicy ?? 'always',
          catchUpMissedStart: persistent,
        })),
      });
      commands.push({ cmd: 'schtasks', args: ['/Run', '/TN', name] });
      return { writes, commands };
    }
    if (action === 'uninstall') {
      commands.push(stopIfRunning());
      commands.push({
        cmd: 'powershell.exe',
        args: windowsPowerShellCommandArgs(buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand({
          qualifiedTaskName: name,
        })),
      });
      return { writes, commands, removals: [{ path: definitionPath, beforeCommandIndex: commands.length }] };
    }
    if (action === 'start') {
      commands.push({ cmd: 'schtasks', args: ['/Run', '/TN', name] });
      return { writes, commands };
    }
    if (action === 'activate') {
      commands.push(setEnabled(true));
      commands.push({ cmd: 'schtasks', args: ['/Run', '/TN', name] });
      return { writes, commands };
    }
    if (action === 'stop') {
      commands.push(stopIfRunning());
      return { writes, commands };
    }
    if (action === 'quarantine') {
      commands.push(setEnabled(false));
      commands.push(stopIfRunning());
      return { writes, commands };
    }
    if (action === 'restart') {
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', name], allowFail: true });
      commands.push({ cmd: 'schtasks', args: ['/Run', '/TN', name] });
      return { writes, commands };
    }
  }

  throw new Error(`Unsupported plan: ${backend} ${action}`);
}

export async function applyServicePlan(plan: ServicePlan, options: Readonly<{ runCommands?: boolean }> = {}): Promise<void> {
  let launchdUsedLegacyLoadFallback = false;
  for (const w of plan.writes) {
    await writeAtomicTextFile(w.path, w.contents, w.mode ?? 0o644);
  }
  if (options.runCommands === false) return;
  const removals = [...(plan.removals ?? [])];
  const applyRemovals = async (beforeCommandIndex: number): Promise<void> => {
    for (const removal of removals.filter((entry) => entry.beforeCommandIndex === beforeCommandIndex)) {
      await rm(removal.path, { force: true });
    }
  };
  for (let commandIndex = 0; commandIndex < plan.commands.length; commandIndex += 1) {
    await applyRemovals(commandIndex);
    const c = plan.commands[commandIndex]!;
    if (launchdUsedLegacyLoadFallback && c.cmd === 'launchctl') {
      const first = Array.isArray(c.args) ? String(c.args[0] ?? '').trim() : '';
      if (first === 'enable' || first === 'kickstart') {
        continue;
      }
    }
    if (!commandExistsOnPath(c.cmd, { path: process.env.PATH })) {
      throw new Error(`[service] command not found: ${c.cmd}`);
    }
    let res = spawnBackgroundSync(c.cmd, [...c.args], {
      encoding: 'utf8',
      env: buildServiceCommandEnv({ cmd: c.cmd, args: c.args, env: process.env }),
    });
    if (res.error) {
      if (c.allowFail) continue;
      throw new Error(`[service] failed to run ${c.cmd}: ${res.error.message}`);
    }

    let status = typeof res.status === 'number' ? res.status : null;
    if (status !== 0 && !c.allowFail && shouldRetryLaunchctlKickstart({ cmd: c.cmd, args: c.args, status, stderr: res.stderr })) {
      res = await retryLaunchctlKickstart({ cmd: c.cmd, args: c.args });
      status = typeof res.status === 'number' ? res.status : null;
    }

    // Some macOS setups return a generic EIO (exit 5) when bootstrapping into the GUI launchd domain.
    // Fall back to the legacy load/unload flow, which is more permissive and still supported.
    if (status !== 0 && !c.allowFail && c.cmd === 'launchctl') {
      const args = Array.isArray(c.args) ? c.args.map((a) => String(a ?? '')) : [];
      if (args[0] === 'bootstrap' && /^gui\/\d+$/.test(args[1] ?? '') && typeof status === 'number' && status === 5 && args[2]) {
        spawnBackgroundSync('launchctl', ['unload', '-w', args[2]], { encoding: 'utf8', env: process.env });
        const loadRes = spawnBackgroundSync('launchctl', ['load', '-w', args[2]], { encoding: 'utf8', env: process.env });
        const loadStatus = typeof loadRes.status === 'number' ? loadRes.status : null;
        if (loadRes.error) {
          throw new Error(`[service] failed to run launchctl load: ${loadRes.error.message}`);
        }
        if (loadStatus === 0) {
          launchdUsedLegacyLoadFallback = true;
          continue;
        }
        const loadStderr = String(loadRes.stderr ?? '').trim();
        const loadStdout = String(loadRes.stdout ?? '').trim();
        const loadSuffix = [loadStdout ? `stdout:\n${loadStdout}` : '', loadStderr ? `stderr:\n${loadStderr}` : '']
          .filter(Boolean)
          .join('\n');
        const loadDetails = loadSuffix ? `\n${loadSuffix}` : '';
        throw new Error(`[service] launchctl bootstrap failed (exit ${status}); fallback to launchctl load also failed (${loadStatus ?? 'unknown'}): launchctl load -w ${args[2]}${loadDetails}`.trim());
      }
    }

    if (status !== 0) {
      if (c.fallbackCommands && c.fallbackCommands.length > 0) {
        await applyServicePlan({ writes: [], commands: [...c.fallbackCommands] }, options);
        continue;
      }
      if (c.allowFail) continue;
      if (c.expectedFailure === 'service-absent' && isBenignServiceAbsenceFailure({
        cmd: c.cmd,
        args: c.args,
        status,
        stdout: res.stdout,
        stderr: res.stderr,
      })) {
        if (c.completePlanOnExpectedFailure) return;
        continue;
      }
      const knownFailure = explainKnownServiceCommandFailure({ cmd: c.cmd, args: c.args, stderr: res.stderr });
      if (knownFailure) {
        throw new Error(knownFailure);
      }
      const stderr = String(res.stderr ?? '').trim();
      const stdout = String(res.stdout ?? '').trim();
      const suffix = [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : ''].filter(Boolean).join('\n');
      const details = suffix ? `\n${suffix}` : '';
      throw new Error(`[service] command failed (${status ?? 'unknown'}): ${c.cmd} ${c.args.join(' ')}${details}`.trim());
    }
  }
  await applyRemovals(plan.commands.length);
}

export function isBenignServiceAbsenceFailure(params: Readonly<{
  cmd: string;
  args: readonly string[];
  status: number | null;
  stdout: unknown;
  stderr: unknown;
}>): boolean {
  if (params.status === 0) return false;
  const output = `${String(params.stdout ?? '')}\n${String(params.stderr ?? '')}`;
  if (params.cmd === 'systemctl') {
    const action = params.args.find((arg) => !String(arg).startsWith('-')) ?? '';
    if (action !== 'disable' && action !== 'stop' && action !== 'show') return false;
    return /(?:unit|unit file).*(?:does not exist|not found|not loaded)|could not be found/i.test(output);
  }
  if (params.cmd === 'launchctl') {
    const action = String(params.args[0] ?? '');
    if (!['bootout', 'disable', 'print'].includes(action)) return false;
    return /could not find (?:specified )?service|service.*not found|no such process/i.test(output);
  }
  return false;
}

export function inspectServiceRegistration(params: Readonly<{
  backend: ServiceBackend;
  label: string;
  taskName?: string;
  uid?: number | null;
}>): ServiceRegistrationState {
  const backend = params.backend;
  const label = String(params.label ?? '').trim();
  if (!label) throw new Error('[service] label is required for registration inspection');
  const uid = resolveUid(params.uid);
  let cmd: string;
  let args: string[];
  if (backend === 'systemd-user' || backend === 'systemd-system') {
    cmd = 'systemctl';
    args = [...(backend === 'systemd-user' ? ['--user'] : []), 'show', `${label}.service`, '--property=LoadState', '--value'];
  } else if (backend === 'launchd-user' || backend === 'launchd-system') {
    const domain = backend === 'launchd-user' ? (uid != null ? `gui/${uid}` : '') : 'system';
    if (!domain) throw new Error('[service] cannot inspect launchd user registration without a uid');
    cmd = 'launchctl';
    args = ['print', `${domain}/${label}`];
  } else {
    const qualifiedTaskName = String(params.taskName ?? '').trim() || `Happier\\${label}`;
    const { taskName, taskPath } = splitQualifiedWindowsScheduledTaskName(qualifiedTaskName);
    cmd = 'powershell.exe';
    args = [...windowsPowerShellCommandArgs(buildReadWindowsScheduledTaskStatusPowerShellCommand({ taskName, taskPath }))];
  }
  if (!commandExistsOnPath(cmd, { path: process.env.PATH })) throw new Error(`[service] command not found: ${cmd}`);
  const res = spawnBackgroundSync(cmd, args, { encoding: 'utf8', env: buildServiceCommandEnv({ cmd, args, env: process.env, uid }) });
  if (res.error) throw new Error(`[service] failed to inspect ${label}: ${res.error.message}`);
  const status = typeof res.status === 'number' ? res.status : null;
  const stdout = String(res.stdout ?? '').trim();
  if (status === 0) {
    if (cmd === 'systemctl' && /^not-found$/i.test(stdout)) return 'absent';
    if (cmd === 'powershell.exe') {
      const snapshot = parseWindowsScheduledTaskStatusPowerShellJson(stdout);
      if (!snapshot) throw new Error(`[service] failed to parse Windows scheduled task status for ${label}`);
      return snapshot.exists ? 'registered' : 'absent';
    }
    return 'registered';
  }
  if (isBenignServiceAbsenceFailure({ cmd, args, status, stdout: res.stdout, stderr: res.stderr })) return 'absent';
  const detail = String(res.stderr ?? res.stdout ?? '').trim();
  throw new Error(`[service] failed to inspect ${label}: ${cmd} ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
}

function explainKnownServiceCommandFailure(params: Readonly<{
  cmd: string;
  args: readonly string[];
  stderr: unknown;
}>): string | null {
  if (params.cmd === 'systemctl' && Array.isArray(params.args) && params.args.includes('--user')) {
    const stderr = String(params.stderr ?? '');
    if (/failed to connect to bus/i.test(stderr)) {
      return 'Systemd user service is unavailable. Ensure the host has a user systemd session (e.g. enable lingering) or use system mode.';
    }
  }
  return null;
}

function shouldRetryLaunchctlKickstart(params: Readonly<{ cmd: string; args: readonly string[]; status: number | null; stderr: unknown }>): boolean {
  if (params.cmd !== 'launchctl') return false;
  if (params.status !== 113) return false;
  const args = Array.isArray(params.args) ? params.args : [];
  if (args[0] !== 'kickstart') return false;
  const stderr = String(params.stderr ?? '');
  return stderr.includes('Could not find service');
}

async function retryLaunchctlKickstart(params: Readonly<{ cmd: string; args: readonly string[] }>): Promise<SpawnSyncReturns<string>> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const res = spawnBackgroundSync(params.cmd, [...params.args], { encoding: 'utf8', env: process.env });
    if (res.error) return res;
    const status = typeof res.status === 'number' ? res.status : null;
    if (status === 0) return res;
    if (!shouldRetryLaunchctlKickstart({ cmd: params.cmd, args: params.args, status, stderr: res.stderr })) {
      return res;
    }
  }
  return spawnBackgroundSync(params.cmd, [...params.args], { encoding: 'utf8', env: process.env });
}

async function writeAtomicTextFile(path: string, contents: string, mode: number): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`);
  await writeFile(tmp, contents, 'utf-8');
  await rename(tmp, path);
  try {
    await chmod(path, mode);
  } catch {
    // ignore
  }
}
