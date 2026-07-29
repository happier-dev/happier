/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import spawn from 'cross-spawn';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { listProcessSnapshot } from './processSnapshotCache';
import {
  readWindowsProcessInventory,
  type WindowsProcessInventoryFact,
} from './platform/windows/windowsProcessInventory';

const DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
] as const;
const WINDOWS_HAPPY_HOST_PROCESS_NAMES = new Set(['happier', 'happier.exe', 'node', 'node.exe', 'bun', 'bun.exe', 'mainthread']);

export type DaemonOwnershipEnvironmentVariables = Partial<Record<
  typeof DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS[number],
  string
>>;

export type HappyProcessInfo = {
  pid: number;
  command: string;
  type: string;
  daemonOwnershipEnvironmentVariables?: DaemonOwnershipEnvironmentVariables;
};

type RawProcessInfo = {
  pid: number;
  name?: string;
  cmd?: string;
  daemonOwnershipEnvironmentVariables?: DaemonOwnershipEnvironmentVariables;
};

function parseEnvironmentEntries(entries: readonly string[]): Array<readonly [string, string]> {
  return entries.flatMap((entry) => {
    const index = entry.indexOf('=');
    if (index <= 0) return [];
    return [[entry.slice(0, index), entry.slice(index + 1)] as const];
  });
}

function pickEnvironmentVariables<Key extends string>(
  pairs: readonly (readonly [string, string])[],
  keys: readonly Key[],
): Partial<Record<Key, string>> | undefined {
  const keySet = new Set<string>(keys);
  const picked: Partial<Record<Key, string>> = {};
  for (const [key, value] of pairs) {
    if (!keySet.has(key)) continue;
    const trimmed = value.trim();
    if (trimmed) {
      picked[key as Key] = trimmed;
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

async function readProcessEnvironmentPairsFromProcfs(pid: number): Promise<Array<readonly [string, string]> | null> {
  if (process.platform !== 'linux') return null;
  try {
    const raw = await readFile(`/proc/${pid}/environ`);
    if (!raw || raw.length === 0) return null;
    return parseEnvironmentEntries(raw.toString('utf8').split('\u0000').filter(Boolean));
  } catch {
    return null;
  }
}

async function readDaemonOwnershipEnvironmentVariablesFromProcfs(
  pid: number,
): Promise<DaemonOwnershipEnvironmentVariables | undefined> {
  const pairs = await readProcessEnvironmentPairsFromProcfs(pid);
  return pairs
    ? pickEnvironmentVariables(pairs, DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS)
    : undefined;
}

function readDaemonOwnershipEnvironmentVariablesFromPosixPs(
  pid: number,
): DaemonOwnershipEnvironmentVariables | undefined {
  if (process.platform === 'linux' || process.platform === 'win32') return undefined;
  try {
    const raw = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pairs = parseEnvironmentEntries(raw.split(/\s+/u).filter(Boolean));
    return pickEnvironmentVariables(pairs, DAEMON_OWNERSHIP_ENVIRONMENT_VARIABLE_KEYS);
  } catch {
    return undefined;
  }
}

async function readDaemonOwnershipEnvironmentVariablesByPid(
  pid: number,
): Promise<DaemonOwnershipEnvironmentVariables | undefined> {
  return await readDaemonOwnershipEnvironmentVariablesFromProcfs(pid)
    ?? readDaemonOwnershipEnvironmentVariablesFromPosixPs(pid);
}

async function getProcessInfoByPidProcfs(pid: number): Promise<RawProcessInfo | null> {
  // Prefer /proc on Linux: it's faster and avoids races/parsing issues from repeated `ps` calls.
  if (process.platform !== 'linux') return null;
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    if (!raw || raw.length === 0) return null;
    const parts = raw
      .toString('utf8')
      .split('\u0000')
      .filter(Boolean);
    if (parts.length === 0) return null;
    const cmd = parts.join(' ');
    const name = path.basename(parts[0] ?? '');
    const daemonOwnershipEnvironmentVariables = await readDaemonOwnershipEnvironmentVariablesFromProcfs(pid);
    return { pid, name, cmd, daemonOwnershipEnvironmentVariables };
  } catch {
    return null;
  }
}

function normalizeProcessName(name: string | undefined): string {
  const normalized = String(name ?? '').trim().replaceAll('\\', '/').toLowerCase();
  return normalized.split('/').pop() ?? normalized;
}

function isWindowsHappyHostProcessCandidate(name: string | undefined): boolean {
  return WINDOWS_HAPPY_HOST_PROCESS_NAMES.has(normalizeProcessName(name));
}

function isCliSourceSnapshotCommand(normalizedCommand: string): boolean {
  return normalizedCommand.includes('/cli-dist-snapshot/src/index.ts') ||
    normalizedCommand.includes('/cli-dist/src/index.ts');
}

function projectWindowsDoctorProcessInfo(
  fact: WindowsProcessInventoryFact,
): RawProcessInfo {
  return {
    pid: fact.pid,
    ...(fact.name ? { name: fact.name } : {}),
    ...(fact.command ? { cmd: fact.command } : {}),
  };
}

async function readWindowsDoctorProcessInventory(
  pids?: readonly number[],
): Promise<Map<number, RawProcessInfo>> {
  if (process.platform !== 'win32') return new Map();
  try {
    const facts = await readWindowsProcessInventory({
      execFile: async (command, args, options) => ({
        stdout: execFileSync(command, [...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: options.timeout,
          maxBuffer: options.maxBuffer,
        }),
      }),
      ...(pids ? { pids } : {}),
    });
    return new Map(
      [...facts.values()].map((fact) => [
        fact.pid,
        projectWindowsDoctorProcessInfo(fact),
      ]),
    );
  } catch {
    return new Map();
  }
}

async function getProcessInfosByPidWindows(
  pids: readonly number[],
): Promise<Map<number, RawProcessInfo>> {
  return await readWindowsDoctorProcessInventory(pids);
}

async function getAllProcessInfosWindows(): Promise<Map<number, RawProcessInfo>> {
  return await readWindowsDoctorProcessInventory();
}

async function getProcessInfoByPidWindows(pid: number): Promise<RawProcessInfo | null> {
  return (await getProcessInfosByPidWindows([pid])).get(pid) ?? null;
}

function getProcessInfoByPidPosix(pid: number): RawProcessInfo | null {
  if (process.platform === 'linux' || process.platform === 'win32') return null;

  try {
    const name = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!name && !cmd) return null;
    const daemonOwnershipEnvironmentVariables = readDaemonOwnershipEnvironmentVariablesFromPosixPs(pid);
    return {
      pid,
      ...(name ? { name } : {}),
      ...(cmd ? { cmd } : {}),
      ...(daemonOwnershipEnvironmentVariables
        ? { daemonOwnershipEnvironmentVariables }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Find all Happier CLI processes (including current process)
 */
export function classifyHappyProcess(proc: RawProcessInfo): HappyProcessInfo | null {
  const cmd = proc.cmd || '';
  const name = proc.name || '';
  const normalizedCommand = cmd.replaceAll('\\', '/');
  const normalizedName = normalizeProcessName(name);
  const isNodeHostProcess = normalizedName === 'node' || normalizedName === 'node.exe' || normalizedName === 'mainthread';
  const isCliSourceSnapshot = isCliSourceSnapshotCommand(normalizedCommand);

  // NOTE: Be intentionally strict here. This classification is used for PID reuse safety
  // (reattach + stopSession). A false positive could cause us to adopt/kill a non-Happy process.
  const isHappy =
    (isNodeHostProcess &&
      (normalizedCommand.includes('@happier-dev/cli') ||
        normalizedCommand.includes('dist/index.mjs') ||
        normalizedCommand.includes('package-dist/index.mjs') ||
        normalizedCommand.includes('bin/happier.mjs') ||
        // Some runtime handoff paths execute snapshot `src/index.ts` directly under `node`
        // (without the tsx import hook), so keep this as a first-class Happy process shape.
        isCliSourceSnapshot ||
        (normalizedCommand.includes('tsx') &&
          normalizedCommand.includes('src/index.ts') &&
          (normalizedCommand.includes('apps/cli') ||
            normalizedCommand.includes('@happier-dev/cli') ||
            isCliSourceSnapshot)))) ||
    normalizedCommand.includes('happier.mjs') ||
    normalizedCommand.includes('@happier-dev/cli') ||
    normalizedCommand.includes('package-dist/index.mjs') ||
    normalizedName === 'happier' ||
    normalizedName === 'happier.exe';

  if (!isHappy) return null;

  // Classify process type
  let type = 'unknown';
  if (proc.pid === process.pid) {
    type = 'current';
  } else if (cmd.includes('--version')) {
    type = cmd.includes('tsx') ? 'dev-daemon-version-check' : 'daemon-version-check';
  } else if (cmd.includes('daemon start-sync') || cmd.includes('daemon start')) {
    type = cmd.includes('tsx') ? 'dev-daemon' : 'daemon';
  } else if (cmd.includes('--started-by daemon')) {
    type = cmd.includes('tsx') ? 'dev-daemon-spawned' : 'daemon-spawned-session';
  } else if (cmd.includes('doctor')) {
    type = cmd.includes('tsx') ? 'dev-doctor' : 'doctor';
  } else if (cmd.includes('--yolo')) {
    type = 'dev-session';
  } else {
    type = cmd.includes('tsx') ? 'dev-related' : 'user-session';
  }

  return {
    pid: proc.pid,
    command: cmd || name,
    type,
    ...(proc.daemonOwnershipEnvironmentVariables
      ? { daemonOwnershipEnvironmentVariables: proc.daemonOwnershipEnvironmentVariables }
      : {}),
  };
}

async function findAllHappyProcessesSnapshot(): Promise<HappyProcessInfo[]> {
  try {
    const processes = await listProcessSnapshot().catch((error: unknown) => {
      if (process.platform !== 'win32') throw error;
      return [];
    });
    const windowsProcessInfoByPid = await getProcessInfosByPidWindows(
      processes.filter((proc) => isWindowsHappyHostProcessCandidate(proc.name)).map((proc) => proc.pid),
    );
    const allProcesses: HappyProcessInfo[] = [];
    
    for (const proc of processes) {
      const procfsInfo = process.platform === 'linux' ? await getProcessInfoByPidProcfs(proc.pid) : null;
      const classified = classifyHappyProcess(procfsInfo ?? windowsProcessInfoByPid.get(proc.pid) ?? proc);
      if (!classified) continue;
      if (!classified.daemonOwnershipEnvironmentVariables) {
        const daemonOwnershipEnvironmentVariables = await readDaemonOwnershipEnvironmentVariablesByPid(classified.pid);
        if (daemonOwnershipEnvironmentVariables) {
          classified.daemonOwnershipEnvironmentVariables = daemonOwnershipEnvironmentVariables;
        }
      }
      allProcesses.push(classified);
    }

    if (process.platform === 'win32' && allProcesses.length === 0) {
      for (const proc of (await getAllProcessInfosWindows()).values()) {
        const classified = classifyHappyProcess(proc);
        if (!classified) continue;
        allProcesses.push(classified);
      }
    }

    return allProcesses;
  } catch (error) {
    return [];
  }
}

let findAllHappyProcessesInFlight: Promise<HappyProcessInfo[]> | null = null;

export async function findAllHappyProcesses(): Promise<HappyProcessInfo[]> {
  if (findAllHappyProcessesInFlight) {
    return await findAllHappyProcessesInFlight;
  }
  const snapshot = findAllHappyProcessesSnapshot();
  findAllHappyProcessesInFlight = snapshot;
  try {
    return await snapshot;
  } finally {
    if (findAllHappyProcessesInFlight === snapshot) {
      findAllHappyProcessesInFlight = null;
    }
  }
}

export async function findHappyProcessByPid(pid: number): Promise<HappyProcessInfo | null> {
  const procfs = await getProcessInfoByPidProcfs(pid);
  if (procfs) {
    return classifyHappyProcess(procfs);
  }
  const posixProc = getProcessInfoByPidPosix(pid);
  if (posixProc) {
    return classifyHappyProcess(posixProc);
  }
  const windowsProc = await getProcessInfoByPidWindows(pid);
  if (windowsProc) {
    return classifyHappyProcess(windowsProc);
  }
  const all = await findAllHappyProcesses();
  return all.find((p) => p.pid === pid) ?? null;
}

/**
 * Find all runaway Happier CLI processes that should be killed
 */
export async function findRunawayHappyProcesses(): Promise<Array<{ pid: number, command: string }>> {
  const allProcesses = await findAllHappyProcesses();
  
  // Filter to just runaway processes (excluding current process)
  return allProcesses
    .filter(p => 
      p.pid !== process.pid && (
        p.type === 'daemon' ||
        p.type === 'dev-daemon' ||
        p.type === 'daemon-spawned-session' ||
        p.type === 'dev-daemon-spawned' ||
        p.type === 'daemon-version-check' ||
        p.type === 'dev-daemon-version-check'
      )
    )
    .map(p => ({ pid: p.pid, command: p.command }));
}

/**
 * Kill all runaway Happier CLI processes
 */
export async function killRunawayHappyProcesses(): Promise<{ killed: number, errors: Array<{ pid: number, error: string }> }> {
  const runawayProcesses = await findRunawayHappyProcesses();
  const errors: Array<{ pid: number, error: string }> = [];
  let killed = 0;
  
  for (const { pid, command } of runawayProcesses) {
    try {
      console.log(`Killing runaway process PID ${pid}: ${command}`);
      
      if (process.platform === 'win32') {
        // Windows: use taskkill
        const result = spawn.sync('taskkill', ['/F', '/PID', pid.toString()], { stdio: 'pipe' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`taskkill exited with code ${result.status}`);
      } else {
        // Unix: try SIGTERM first
        process.kill(pid, 'SIGTERM');
        
        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check if still alive
        const processes = await listProcessSnapshot({ ttlMs: 0 });
        const stillAlive = processes.find(p => p.pid === pid);
        if (stillAlive) {
          console.log(`Process PID ${pid} ignored SIGTERM, using SIGKILL`);
          process.kill(pid, 'SIGKILL');
        }
      }
      
      console.log(`Successfully killed runaway process PID ${pid}`);
      killed++;
    } catch (error) {
      const errorMessage = (error as Error).message;
      errors.push({ pid, error: errorMessage });
      console.log(`Failed to kill process PID ${pid}: ${errorMessage}`);
    }
  }

  return { killed, errors };
}
