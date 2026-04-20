/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import psList from 'ps-list';
import spawn from 'cross-spawn';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const WINDOWS_HAPPY_HOST_PROCESS_NAMES = new Set(['happier', 'happier.exe', 'node', 'node.exe', 'bun', 'bun.exe', 'mainthread']);

export type HappyProcessInfo = { pid: number; command: string; type: string };

async function getProcessInfoByPidProcfs(pid: number): Promise<{ pid: number; name?: string; cmd?: string } | null> {
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
    return { pid, name, cmd };
  } catch {
    return null;
  }
}

function normalizeProcessName(name: string | undefined): string {
  return String(name ?? '').trim().toLowerCase();
}

function isWindowsHappyHostProcessCandidate(name: string | undefined): boolean {
  return WINDOWS_HAPPY_HOST_PROCESS_NAMES.has(normalizeProcessName(name));
}

function isCliSourceSnapshotCommand(normalizedCommand: string): boolean {
  return normalizedCommand.includes('/cli-dist-snapshot/src/index.ts') ||
    normalizedCommand.includes('/cli-dist/src/index.ts');
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseWindowsProcessInfoOutput(output: string): Map<number, { pid: number; name?: string; cmd?: string }> {
  const trimmed = output.trim();
  if (!trimmed) return new Map();

  const parsed = JSON.parse(trimmed) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result = new Map<number, { pid: number; name?: string; cmd?: string }>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const pid = parsePositiveInt((row as { ProcessId?: unknown }).ProcessId);
    if (!pid) continue;
    const name = typeof (row as { Name?: unknown }).Name === 'string' ? (row as { Name?: string }).Name : undefined;
    const commandLine = typeof (row as { CommandLine?: unknown }).CommandLine === 'string'
      ? (row as { CommandLine?: string }).CommandLine?.trim()
      : undefined;
    result.set(pid, { pid, ...(name ? { name } : {}), ...(commandLine ? { cmd: commandLine } : {}) });
  }
  return result;
}

async function getProcessInfosByPidWindows(
  pids: readonly number[],
): Promise<Map<number, { pid: number; name?: string; cmd?: string }>> {
  if (process.platform !== 'win32') return new Map();

  const uniquePids = Array.from(new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0)));
  if (uniquePids.length === 0) return new Map();

  try {
    const filter = uniquePids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const script = [
      `$rows = Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId, Name, CommandLine`,
      'if ($null -eq $rows) { return }',
      '$rows | ConvertTo-Json -Compress',
    ].join('; ');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return parseWindowsProcessInfoOutput(output);
  } catch {
    return new Map();
  }
}

async function getAllProcessInfosWindows(): Promise<Map<number, { pid: number; name?: string; cmd?: string }>> {
  if (process.platform !== 'win32') return new Map();

  try {
    const script = [
      '$rows = Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine',
      'if ($null -eq $rows) { return }',
      '$rows | ConvertTo-Json -Compress',
    ].join('; ');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return parseWindowsProcessInfoOutput(output);
  } catch {
    return new Map();
  }
}

async function getProcessInfoByPidWindows(pid: number): Promise<{ pid: number; name?: string; cmd?: string } | null> {
  return (await getProcessInfosByPidWindows([pid])).get(pid) ?? null;
}

/**
 * Find all Happier CLI processes (including current process)
 */
export function classifyHappyProcess(proc: { pid: number; name?: string; cmd?: string }): HappyProcessInfo | null {
  const cmd = proc.cmd || '';
  const name = proc.name || '';
  const normalizedCommand = cmd.replaceAll('\\', '/');
  const normalizedName = normalizeProcessName(name);
  const isNodeHostProcess = normalizedName === 'node' || normalizedName === 'node.exe' || normalizedName === 'mainthread';

  // NOTE: Be intentionally strict here. This classification is used for PID reuse safety
  // (reattach + stopSession). A false positive could cause us to adopt/kill a non-Happy process.
  const isHappy =
    (isNodeHostProcess &&
      (normalizedCommand.includes('@happier-dev/cli') ||
        normalizedCommand.includes('dist/index.mjs') ||
        normalizedCommand.includes('package-dist/index.mjs') ||
        normalizedCommand.includes('bin/happier.mjs') ||
        (normalizedCommand.includes('tsx') &&
          normalizedCommand.includes('src/index.ts') &&
          (normalizedCommand.includes('apps/cli') ||
            normalizedCommand.includes('@happier-dev/cli') ||
            isCliSourceSnapshotCommand(normalizedCommand))))) ||
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

  return { pid: proc.pid, command: cmd || name, type };
}

export async function findAllHappyProcesses(): Promise<HappyProcessInfo[]> {
  try {
    const processes = await psList().catch((error: unknown) => {
      if (process.platform !== 'win32') throw error;
      return [];
    });
    const windowsProcessInfoByPid = await getProcessInfosByPidWindows(
      processes.filter((proc) => isWindowsHappyHostProcessCandidate(proc.name)).map((proc) => proc.pid),
    );
    const allProcesses: HappyProcessInfo[] = [];
    
    for (const proc of processes) {
      const classified = classifyHappyProcess(windowsProcessInfoByPid.get(proc.pid) ?? proc);
      if (!classified) continue;
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

export async function findHappyProcessByPid(pid: number): Promise<HappyProcessInfo | null> {
  const procfs = await getProcessInfoByPidProcfs(pid);
  if (procfs) {
    return classifyHappyProcess(procfs);
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
        const processes = await psList();
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
