import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import { buildServiceCommandEnv } from '@happier-dev/cli-common/service';

import type { DaemonServiceMode } from './plan';

export type ServiceHealthSignal = Readonly<{
  runs: number | null;
  lastExitCode: number | null;
  isCrashLooping: boolean;
  lastErrorLine: string | null;
  suspectedCause: SuspectedCause;
  conflictingManualDaemonPid: number | null;
}>;

type SystemdUnitStatus = Readonly<{
  activeState: string | null;
  subState: string | null;
  result: string | null;
  execMainStatus: number | null;
  nRestarts: number | null;
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

function readLaunchdHealth(params: Readonly<{
  uid: number | null;
  label: string;
}>): Pick<ServiceHealthSignal, 'runs' | 'lastExitCode' | 'isCrashLooping' | 'lastErrorLine'> {
  const launchctlOutput = params.uid != null ? tryReadLaunchctl(params.uid, params.label) : '';
  const { runs, lastExitCode } = parseLaunchctlFields(launchctlOutput);
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

function tryReadLaunchctl(uid: number, label: string): string {
  const args = ['print', `gui/${uid}/${label}`];
  try {
    const result = spawnSync('launchctl', args, {
      encoding: 'utf-8',
      timeout: 2_000,
      env: buildServiceCommandEnv({ cmd: 'launchctl', args, env: process.env }),
    });
    if (result.status !== 0) return '';
    return String(result.stdout ?? '');
  } catch {
    return '';
  }
}

function tryReadSystemdStatus(params: Readonly<{
  unitName: string;
  mode: DaemonServiceMode;
  uid: number | null;
}>): SystemdUnitStatus | null {
  const args = [
    ...systemdScopeArgs(params.mode),
    'show',
    params.unitName,
    '--property=Result,ExecMainStatus,NRestarts,ActiveState,SubState',
    '--no-pager',
  ];
  try {
    const result = spawnSync('systemctl', args, {
      encoding: 'utf-8',
      timeout: 2_000,
      env: buildServiceCommandEnv({ cmd: 'systemctl', args, env: process.env, uid: params.uid }),
    });
    if (result.status !== 0) return null;
    return readSystemdUnitStatus(String(result.stdout ?? ''));
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
    const result = spawnSync('journalctl', args, {
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

function readSystemdUnitStatus(output: string): SystemdUnitStatus {
  const raw = parseKeyValueLines(output);
  return {
    activeState: raw.ActiveState ?? null,
    subState: raw.SubState ?? null,
    result: raw.Result ?? null,
    execMainStatus: parseIntOrNull(raw.ExecMainStatus),
    nRestarts: parseIntOrNull(raw.NRestarts),
  };
}

function parseKeyValueLines(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of String(raw ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (!key) continue;
    values[key] = trimmed.slice(index + 1);
  }
  return values;
}

function parseIntOrNull(value: string | undefined): number | null {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
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
