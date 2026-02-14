import { dirname, join } from 'node:path';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { buildLaunchdPath, buildLaunchdPlistXml } from './launchd.js';
import { renderSystemdServiceUnit } from './systemd.js';
import { renderWindowsScheduledTaskWrapperPs1 } from './windows.js';

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
    return `C:\\\\ProgramData\\\\happier\\\\services\\\\${params.label}.ps1`;
  }
  return `${base}\\\\.happier\\\\services\\\\${params.label}.ps1`;
}

export function buildServiceDefinition(params: Readonly<{ backend: ServiceBackend; homeDir: string; spec: ServiceSpec }>): ServiceDefinition {
  const s = normalizeSpec(params.spec);
  const backend = String(params.backend ?? '').trim() as ServiceBackend;

  if (backend === 'systemd-user' || backend === 'systemd-system') {
    const mode: ServiceMode = backend === 'systemd-system' ? 'system' : 'user';
    const path = systemdUnitPathForLabel({ homeDir: params.homeDir, label: s.label, mode });
    const contents = renderSystemdServiceUnit({
      description: s.description,
      execStart: s.programArgs,
      workingDirectory: s.workingDirectory,
      env: s.env,
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
    const mergedEnv = {
      ...(s.env ?? {}),
      PATH: buildLaunchdPath({ execPath: process.execPath, basePath: process.env.PATH }),
    };
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
      env: s.env,
      stdoutPath: s.stdoutPath,
      stderrPath: s.stderrPath,
    });
    return { kind: 'windows-wrapper-ps1', path, contents, mode: 0o644 };
  }

  throw new Error(`Unsupported backend: ${backend}`);
}

function resolveUid(uid: number | null | undefined): number | null {
  if (typeof uid === 'number' && Number.isFinite(uid) && uid >= 0) return Math.floor(uid);
  if (typeof process.getuid === 'function') return process.getuid();
  return null;
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
      commands.push({
        cmd: 'systemctl',
        args: persistent ? [...prefix, 'enable', '--now', unitName] : [...prefix, 'start', unitName],
      });
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
      const ps = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${definitionPath}"`;
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

function commandExists(cmd: string, envPath: string | undefined): boolean {
  const name = String(cmd ?? '').trim();
  if (!name) return false;
  if (process.platform === 'win32') {
    const res = spawnSync('where', [name], { stdio: 'ignore', env: { ...process.env, PATH: envPath ?? process.env.PATH } });
    return (res.status ?? 1) === 0;
  }
  const res = spawnSync('sh', ['-lc', `command -v ${name} >/dev/null 2>&1`], { stdio: 'ignore', env: { ...process.env, PATH: envPath ?? process.env.PATH } });
  return (res.status ?? 1) === 0;
}

export async function applyServicePlan(plan: ServicePlan, options: Readonly<{ runCommands?: boolean }> = {}): Promise<void> {
  for (const w of plan.writes) {
    await writeAtomicTextFile(w.path, w.contents, w.mode ?? 0o644);
  }
  if (options.runCommands === false) return;
  for (const c of plan.commands) {
    if (!commandExists(c.cmd, process.env.PATH)) {
      throw new Error(`[service] command not found: ${c.cmd}`);
    }
    const res = spawnSync(c.cmd, [...c.args], { encoding: 'utf8', env: process.env });
    if (res.error) {
      if (c.allowFail) continue;
      throw new Error(`[service] failed to run ${c.cmd}: ${res.error.message}`);
    }
    const status = typeof res.status === 'number' ? res.status : null;
    if (status !== 0) {
      if (c.allowFail) continue;
      const stderr = String(res.stderr ?? '').trim();
      const suffix = stderr ? `\n${stderr}` : '';
      throw new Error(`[service] command failed (${status ?? 'unknown'}): ${c.cmd} ${c.args.join(' ')}${suffix}`.trim());
    }
  }
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
