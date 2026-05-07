import { dirname, join } from 'node:path';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { userInfo } from 'node:os';

import { commandExistsOnPath } from '../process/index.js';
import { buildLaunchdPlistXml } from './launchd.js';
import { mergeServiceEnvWithPath } from './path.js';
import { renderSystemdServiceUnit } from './systemd.js';
import { buildWindowsScheduledTaskPowerShellAction, renderWindowsScheduledTaskWrapperPs1 } from './windows.js';

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
}>;

export type ServiceDefinition = Readonly<{
  kind: 'systemd-service' | 'launchd-plist' | 'windows-wrapper-ps1';
  path: string;
  contents: string;
  mode: number;
}>;

export type PlannedWrite = Readonly<{ path: string; contents: string; mode?: number }>;
export type PlannedCommand = Readonly<{ cmd: string; args: readonly string[]; allowFail?: boolean }>;
export type ServicePlan = Readonly<{ writes: PlannedWrite[]; commands: PlannedCommand[] }>;

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
    const path = systemdUnitPathForLabel({ homeDir: params.homeDir, label: s.label, mode });
    const contents = renderSystemdServiceUnit({
      description: s.description,
      execStart: s.programArgs,
      workingDirectory: s.workingDirectory,
      env: mergedEnv,
      restart: 'always',
      runAsUser: s.runAsUser,
      stdoutPath: s.stdoutPath,
      stderrPath: s.stderrPath,
      wantedBy: mode === 'system' ? 'multi-user.target' : 'default.target',
    });
    return { kind: 'systemd-service', path, contents, mode: 0o644 };
  }

  if (backend === 'launchd-user' || backend === 'launchd-system') {
    const mode: ServiceMode = backend === 'launchd-system' ? 'system' : 'user';
    const path = launchdPlistPathForLabel({ homeDir: params.homeDir, label: s.label, mode });
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
    const path = windowsWrapperPathForLabel({ homeDir: params.homeDir, label: s.label, mode });
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
  action: 'install' | 'uninstall' | 'start' | 'stop' | 'restart';
  label: string;
  definitionPath?: string;
  definitionContents?: string;
  taskName?: string;
  persistent?: boolean;
  uid?: number | null;
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

  const writes: PlannedWrite[] = [];
  const commands: PlannedCommand[] = [];

  if (action === 'install') {
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
      commands.push({ cmd: 'systemctl', args: [...prefix, 'restart', unitName] });
      return { writes, commands };
    }
    if (action === 'uninstall') {
      commands.push({ cmd: 'systemctl', args: [...prefix, 'disable', '--now', unitName], allowFail: true });
      commands.push({ cmd: 'systemctl', args: [...prefix, 'daemon-reload'] });
      return { writes, commands };
    }
    if (action === 'start') {
      commands.push({ cmd: 'systemctl', args: persistent ? [...prefix, 'enable', '--now', unitName] : [...prefix, 'start', unitName] });
      return { writes, commands };
    }
    if (action === 'stop') {
      commands.push({ cmd: 'systemctl', args: persistent ? [...prefix, 'disable', '--now', unitName] : [...prefix, 'stop', unitName], allowFail: true });
      return { writes, commands };
    }
    if (action === 'restart') {
      commands.push({ cmd: 'systemctl', args: [...prefix, 'restart', unitName] });
      return { writes, commands };
    }
  }

  if (backend === 'launchd-user' || backend === 'launchd-system') {
    if (!definitionPath) throw new Error('definitionPath is required for launchd operations');

    const preferBootstrap = backend === 'launchd-user' && uid != null && uid > 0;
    if (action === 'install' || action === 'start') {
      if (preferBootstrap) {
        commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${label}`], allowFail: true });
        commands.push({ cmd: 'launchctl', args: ['bootstrap', `gui/${uid}`, definitionPath] });
        commands.push({ cmd: 'launchctl', args: ['enable', `gui/${uid}/${label}`] });
        commands.push({ cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] });
      } else {
        if (action === 'install') {
          commands.push({ cmd: 'launchctl', args: persistent ? ['unload', '-w', definitionPath] : ['unload', definitionPath], allowFail: true });
        }
        commands.push({ cmd: 'launchctl', args: persistent ? ['load', '-w', definitionPath] : ['load', definitionPath] });
      }
      return { writes, commands };
    }
    if (action === 'uninstall' || action === 'stop') {
      if (preferBootstrap) {
        commands.push({ cmd: 'launchctl', args: ['disable', `gui/${uid}/${label}`], allowFail: true });
        commands.push({ cmd: 'launchctl', args: ['bootout', `gui/${uid}`, definitionPath], allowFail: true });
        commands.push({ cmd: 'launchctl', args: ['remove', label], allowFail: true });
      } else {
        commands.push({ cmd: 'launchctl', args: persistent ? ['unload', '-w', definitionPath] : ['unload', definitionPath], allowFail: true });
      }
      return { writes, commands };
    }
    if (action === 'restart') {
      if (preferBootstrap) {
        commands.push({ cmd: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] });
      } else {
        commands.push({ cmd: 'launchctl', args: persistent ? ['unload', '-w', definitionPath] : ['unload', definitionPath], allowFail: true });
        commands.push({ cmd: 'launchctl', args: persistent ? ['load', '-w', definitionPath] : ['load', definitionPath] });
      }
      return { writes, commands };
    }
  }

  if (backend === 'schtasks-user' || backend === 'schtasks-system') {
    const name = taskName || `Happier\\${label}`;
    const mode: ServiceMode = backend === 'schtasks-system' ? 'system' : 'user';
    if (action === 'install') {
      if (!definitionPath) throw new Error('definitionPath is required for schtasks install');
      const ps = buildWindowsScheduledTaskPowerShellAction({ definitionPath });
      const schedule = persistent
        ? (mode === 'system' ? 'ONSTART' : 'ONLOGON')
        : 'ONCE';
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
      commands.push({ cmd: 'schtasks', args });
      commands.push({ cmd: 'schtasks', args: ['/Run', '/TN', name] });
      return { writes, commands };
    }
    if (action === 'uninstall') {
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', name], allowFail: true });
      commands.push({ cmd: 'schtasks', args: ['/Delete', '/F', '/TN', name], allowFail: true });
      return { writes, commands };
    }
    if (action === 'start') {
      commands.push({ cmd: 'schtasks', args: ['/Run', '/TN', name] });
      return { writes, commands };
    }
    if (action === 'stop') {
      commands.push({ cmd: 'schtasks', args: ['/End', '/TN', name], allowFail: true });
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
  for (const c of plan.commands) {
    if (launchdUsedLegacyLoadFallback && c.cmd === 'launchctl') {
      const first = Array.isArray(c.args) ? String(c.args[0] ?? '').trim() : '';
      if (first === 'enable' || first === 'kickstart') {
        continue;
      }
    }
    if (!commandExistsOnPath(c.cmd, { path: process.env.PATH })) {
      throw new Error(`[service] command not found: ${c.cmd}`);
    }
    let res = spawnSync(c.cmd, [...c.args], {
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
        spawnSync('launchctl', ['unload', '-w', args[2]], { encoding: 'utf8', env: process.env });
        const loadRes = spawnSync('launchctl', ['load', '-w', args[2]], { encoding: 'utf8', env: process.env });
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
      if (c.allowFail) continue;
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
    const res = spawnSync(params.cmd, [...params.args], { encoding: 'utf8', env: process.env });
    if (res.error) return res;
    const status = typeof res.status === 'number' ? res.status : null;
    if (status === 0) return res;
    if (!shouldRetryLaunchctlKickstart({ cmd: params.cmd, args: params.args, status, stderr: res.stderr })) {
      return res;
    }
  }
  return spawnSync(params.cmd, [...params.args], { encoding: 'utf8', env: process.env });
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
