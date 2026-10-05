import { spawnBackgroundSync } from '@happier-dev/cli-common/process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import {
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  buildServiceCommandEnv,
  parseWindowsScheduledTaskStatusPowerShellJson,
  splitQualifiedWindowsScheduledTaskName,
} from '@happier-dev/cli-common/service';
import { readLaunchdServiceEnabled, readSystemdUnitStatus, type SystemdUnitStatus } from '@happier-dev/cli-common/service/discovery';

import type { DaemonServiceAutostartMode, DaemonServiceInstallEnablement, DaemonServiceMode } from './plan';

export type ServiceHealthSignal = Readonly<{
  runs: number | null;
  lastExitCode: number | null;
  isCrashLooping: boolean;
  lastErrorLine: string | null;
  suspectedCause: SuspectedCause;
  conflictingManualDaemonPid: number | null;
}>;

export type SuspectedCause =
  | 'conflicting_manual_daemon'
  | 'port_in_use'
  | 'auth_missing'
  | 'unknown';

const CRASH_LOOP_RUNS_THRESHOLD = 5;
const ERROR_LINE_MAX_LEN = 200;
const JOURNAL_TAIL_LINES = 40;

export function readBackgroundServiceHealth(params: Readonly<{
  platform: NodeJS.Platform;
  uid: number | null;
  label: string;
  errLogPath: string | null;
  mode?: DaemonServiceMode | null;
}>): ServiceHealthSignal {
  const platformHealth = params.platform === 'darwin'
    ? readLaunchdHealth({ uid: params.uid, label: params.label })
    : params.platform === 'linux'
      ? readSystemdHealth({ label: params.label, mode: params.mode ?? 'user', uid: params.uid })
      : { runs: null, lastExitCode: null, isCrashLooping: false, lastErrorLine: null };

  const lastErrorLine = platformHealth.lastErrorLine
    ?? (params.errLogPath ? readLastNonEmptyErrorLine(params.errLogPath) : null);
  const { suspectedCause, conflictingManualDaemonPid } = classifyErrorLine(lastErrorLine);

  return {
    runs: platformHealth.runs,
    lastExitCode: platformHealth.lastExitCode,
    isCrashLooping: platformHealth.isCrashLooping,
    lastErrorLine,
    suspectedCause,
    conflictingManualDaemonPid,
  };
}

/**
 * Whether the service manager is running (or starting) this background service now — the state
 * `service stop` changes: launchd has it bootstrapped (`stop` boots it out), systemd reports it
 * active, activating or reloading (`stop` leaves it inactive), Task Scheduler reports it running.
 * `unknown` when the manager could not be asked.
 */
export type BackgroundServiceActivity = 'active' | 'inactive' | 'unknown';

export function readBackgroundServiceActivity(params: Readonly<{
  platform: NodeJS.Platform;
  uid: number | null;
  label: string;
  mode?: DaemonServiceMode | null;
}>): BackgroundServiceActivity {
  if (params.platform === 'darwin') {
    if (params.uid == null) return 'unknown';
    const output = tryReadLaunchctl(params.uid, params.label);
    return output === null ? 'unknown' : output ? 'active' : 'inactive';
  }
  if (params.platform === 'linux') {
    const status = tryReadSystemdStatus({
      unitName: normalizeSystemdUnitName(params.label),
      mode: params.mode ?? 'user',
      uid: params.uid,
    });
    if (!status) return 'unknown';
    const activeState = String(status.activeState ?? '').trim().toLowerCase();
    return activeState === 'active' || activeState === 'activating' || activeState === 'reloading' ? 'active' : 'inactive';
  }
  if (params.platform === 'win32') {
    return tryReadScheduledTaskActivity(params.label);
  }
  return 'unknown';
}

function tryReadScheduledTaskActivity(label: string): BackgroundServiceActivity {
  const status = tryReadScheduledTaskStatus(label);
  if (!status) return 'unknown';
  return status.exists && status.active ? 'active' : 'inactive';
}

function tryReadScheduledTaskStatus(label: string, includeAutostart = false) {
  try {
    const task = splitQualifiedWindowsScheduledTaskName(label);
    const result = spawnBackgroundSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildReadWindowsScheduledTaskStatusPowerShellCommand({ ...task, includeAutostart }),
    ], { encoding: 'utf-8', timeout: 5_000 });
    return result.status === 0 ? parseWindowsScheduledTaskStatusPowerShellJson(String(result.stdout ?? '')) : null;
  } catch {
    return null;
  }
}

/** Effective login trigger, not merely the last preference written in the definition. */
export function readBackgroundServiceAutostartMode(params: Readonly<{
  platform: NodeJS.Platform;
  uid: number | null;
  label: string;
  mode?: DaemonServiceMode | null;
  installedMode: DaemonServiceAutostartMode | null;
}>): DaemonServiceAutostartMode | null {
  return readBackgroundServiceLoginState(params).autostart;
}

/** OS enablement is independent of a definition's at-login/on-demand trigger. */
export function readBackgroundServiceEnablement(params: Readonly<{
  platform: NodeJS.Platform;
  uid: number | null;
  label: string;
  mode?: DaemonServiceMode | null;
}>): DaemonServiceInstallEnablement | null {
  return readBackgroundServiceLoginState({ ...params, installedMode: null }).enablement;
}

function readBackgroundServiceLoginState(params: Readonly<{
  platform: NodeJS.Platform;
  uid: number | null;
  label: string;
  mode?: DaemonServiceMode | null;
  installedMode: DaemonServiceAutostartMode | null;
}>): Readonly<{ enablement: DaemonServiceInstallEnablement | null; autostart: DaemonServiceAutostartMode | null }> {
  const unknown = { enablement: null, autostart: null };
  if (params.platform === 'linux') {
    const state = tryReadSystemdStatus({ unitName: normalizeSystemdUnitName(params.label), mode: params.mode ?? 'user', uid: params.uid, includeEnablement: true })?.unitFileState;
    if (state === 'enabled' || state === 'enabled-runtime') return { enablement: 'enabled', autostart: 'at-login' };
    if (state === 'disabled') return { enablement: 'disabled', autostart: 'on-demand' };
    return unknown;
  }
  if (params.platform === 'win32') {
    const status = tryReadScheduledTaskStatus(params.label, true);
    if (!status?.exists) return unknown;
    if (!status.enabled) return { enablement: 'disabled', autostart: 'on-demand' };
    return { enablement: 'enabled', autostart: typeof status.autostart === 'boolean' ? status.autostart ? 'at-login' : 'on-demand' : null };
  }
  if (params.platform === 'darwin' && params.uid !== null) {
    const args = ['print-disabled', `gui/${params.uid}`];
    try {
      const result = spawnBackgroundSync('launchctl', args, { encoding: 'utf-8', timeout: 2_000, env: buildServiceCommandEnv({ cmd: 'launchctl', args, env: process.env }) });
      if (result.status !== 0) return unknown;
      const enabled = readLaunchdServiceEnabled({ output: String(result.stdout ?? '').trim() || null, label: params.label });
      return enabled === false ? { enablement: 'disabled', autostart: 'on-demand' } : enabled === true ? { enablement: 'enabled', autostart: params.installedMode } : unknown;
    } catch {
      return unknown;
    }
  }
  return unknown;
}

function readLaunchdHealth(params: Readonly<{
  uid: number | null;
  label: string;
}>): Pick<ServiceHealthSignal, 'runs' | 'lastExitCode' | 'isCrashLooping' | 'lastErrorLine'> {
  const launchctlOutput = params.uid != null ? tryReadLaunchctl(params.uid, params.label) : '';
  const { runs, lastExitCode } = parseLaunchctlFields(launchctlOutput ?? '');
  return {
    runs,
    lastExitCode,
    isCrashLooping: (runs !== null && runs >= CRASH_LOOP_RUNS_THRESHOLD)
      && (lastExitCode !== null && lastExitCode !== 0),
    lastErrorLine: null,
  };
}

function readSystemdHealth(params: Readonly<{
  label: string;
  mode: DaemonServiceMode;
  uid: number | null;
}>): Pick<ServiceHealthSignal, 'runs' | 'lastExitCode' | 'isCrashLooping' | 'lastErrorLine'> {
  const unitName = normalizeSystemdUnitName(params.label);
  const status = tryReadSystemdStatus({ unitName, mode: params.mode, uid: params.uid });
  const runs = status?.nRestarts ?? null;
  const lastExitCode = status?.execMainStatus ?? null;
  const faulted = status !== null && isFaultedSystemdUnit(status);
  return {
    runs,
    lastExitCode,
    isCrashLooping: runs !== null
      && runs >= CRASH_LOOP_RUNS_THRESHOLD
      && faulted,
    lastErrorLine: faulted
      ? tryReadJournalctlLastErrorLine({ unitName, mode: params.mode, uid: params.uid })
      : null,
  };
}

function normalizeSystemdUnitName(label: string): string {
  const trimmed = String(label ?? '').trim();
  return trimmed.endsWith('.service') ? trimmed : `${trimmed}.service`;
}

function systemdScopeArgs(mode: DaemonServiceMode): readonly string[] {
  return mode === 'system' ? [] : ['--user'];
}

function tryReadLaunchctl(uid: number, label: string): string | null {
  try {
    const args = ['print', `gui/${uid}/${label}`];
    const result = spawnBackgroundSync('launchctl', args, {
      encoding: 'utf-8',
      timeout: 2_000,
      env: buildServiceCommandEnv({ cmd: 'launchctl', args, env: process.env }),
    });
    if (result.error || result.status === null) return null;
    if (result.status !== 0) {
      return String(result.stderr ?? '').trim().startsWith(`Could not find service "${label}" in domain for `) ? '' : null;
    }
    return String(result.stdout ?? '');
  } catch {
    return null;
  }
}

function tryReadSystemdStatus(params: Readonly<{
  unitName: string;
  mode: DaemonServiceMode;
  uid: number | null;
  includeEnablement?: boolean;
}>): SystemdUnitStatus | null {
  const args = [
    ...systemdScopeArgs(params.mode),
    'show',
    params.unitName,
    `--property=Result,ExecMainStatus,NRestarts,ActiveState,SubState${params.includeEnablement ? ',UnitFileState' : ''}`,
    '--no-pager',
  ];
  try {
    const result = spawnBackgroundSync('systemctl', args, {
      encoding: 'utf-8',
      timeout: 2_000,
      env: buildServiceCommandEnv({ cmd: 'systemctl', args, env: process.env, uid: params.uid }),
    });
    if (result.status !== 0) return null;
    return readSystemdUnitStatus({ output: String(result.stdout ?? '') });
  } catch {
    return null;
  }
}

function tryReadJournalctlLastErrorLine(params: Readonly<{
  unitName: string;
  mode: DaemonServiceMode;
  uid: number | null;
}>): string | null {
  const args = [
    ...systemdScopeArgs(params.mode),
    '-u',
    params.unitName,
    '-n',
    String(JOURNAL_TAIL_LINES),
    '--no-pager',
  ];
  try {
    const result = spawnBackgroundSync('journalctl', args, {
      encoding: 'utf-8',
      timeout: 2_000,
      env: buildServiceCommandEnv({ cmd: 'journalctl', args, env: process.env, uid: params.uid }),
    });
    if (result.status !== 0) return null;
    return readLastNonEmptyErrorLineFromText(String(result.stdout ?? ''));
  } catch {
    return null;
  }
}

function isFaultedSystemdUnit(status: SystemdUnitStatus): boolean {
  const result = String(status.result ?? '').trim().toLowerCase();
  const activeState = String(status.activeState ?? '').trim().toLowerCase();
  const subState = String(status.subState ?? '').trim().toLowerCase();
  if (status.execMainStatus !== null && status.execMainStatus !== 0) return true;
  if (result && result !== 'success') return true;
  return activeState === 'failed' || subState === 'failed';
}

function parseLaunchctlFields(output: string): { runs: number | null; lastExitCode: number | null } {
  if (!output) return { runs: null, lastExitCode: null };
  const runsMatch = output.match(/^\s*runs\s*=\s*(\d+)/m);
  const exitMatch = output.match(/^\s*last exit code\s*=\s*(-?\d+)/m);
  return {
    runs: runsMatch ? Number(runsMatch[1]) : null,
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
  };
}

function readLastNonEmptyErrorLine(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    const readSize = Math.min(stats.size, 16 * 1024);
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, Math.max(0, stats.size - readSize));
      return readLastNonEmptyErrorLineFromText(buf.toString('utf-8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    try {
      return readLastNonEmptyErrorLineFromText(readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }
}

function readLastNonEmptyErrorLineFromText(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('(Use `node --trace-deprecation')) continue;
    if (line.includes('DeprecationWarning:')) continue;
    return line.length > ERROR_LINE_MAX_LEN
      ? `${line.slice(0, ERROR_LINE_MAX_LEN - 3)}...`
      : line;
  }
  return null;
}

function classifyErrorLine(line: string | null): { suspectedCause: SuspectedCause; conflictingManualDaemonPid: number | null } {
  if (!line) return { suspectedCause: 'unknown', conflictingManualDaemonPid: null };
  if (/Another manually started daemon is already running/i.test(line)) {
    const pidMatch = line.match(/pid\s+(\d+)/i);
    return {
      suspectedCause: 'conflicting_manual_daemon',
      conflictingManualDaemonPid: pidMatch ? Number(pidMatch[1]) : null,
    };
  }
  if (/EADDRINUSE|already in use|address already in use/i.test(line)) {
    return { suspectedCause: 'port_in_use', conflictingManualDaemonPid: null };
  }
  if (/not authenticated|unauthorized|401|403/i.test(line)) {
    return { suspectedCause: 'auth_missing', conflictingManualDaemonPid: null };
  }
  return { suspectedCause: 'unknown', conflictingManualDaemonPid: null };
}
