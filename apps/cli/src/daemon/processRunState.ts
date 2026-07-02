import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Coarse process run state for daemon liveness decisions.
 *
 * A session runner must be ABLE TO SERVE (consume its pending queue, answer RPC) for the daemon
 * to refuse a resume as "already running". `process.kill(pid, 0)` alone lies for two classes:
 * - `stopped`: SIGSTOPped/traced (`ps` state `T`/`t`) — alive, holds its lock, serves nothing.
 * - `zombie`: defunct (`ps` state `Z`) — signalable on some platforms, permanently dead.
 *
 * Incident class: daemon log 2026-06-12 "Resume requested ... but session is already running"
 * while the runner cannot serve; the user message is materialized into the pending queue and
 * never consumed.
 */
export type ProcessRunState = 'dead' | 'servable' | 'stopped' | 'zombie';

export function isPidAliveBySignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function classifyPosixStateChar(stateOutput: string): ProcessRunState | null {
  const stateChar = stateOutput.trim().charAt(0);
  if (!stateChar) return null;
  if (stateChar === 'T' || stateChar === 't') return 'stopped';
  if (stateChar === 'Z') return 'zombie';
  return 'servable';
}

/**
 * Reads the run state of a process. Fail-closed: when the process is alive but its state cannot
 * be inspected (ps failure, unsupported platform), it is reported `servable` so callers keep the
 * existing duplicate-spawn protection. Windows has no SIGSTOP/zombie semantics → alive = servable.
 */
export async function readProcessRunState(pid: number, deps?: Readonly<{
  isPidAlive?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
}>): Promise<ProcessRunState> {
  if (!Number.isFinite(pid) || pid <= 0) return 'dead';
  const isPidAlive = deps?.isPidAlive ?? isPidAliveBySignal;
  const platform = deps?.platform ?? process.platform;
  const alive = isPidAlive(pid);

  if (platform === 'win32') {
    return alive ? 'servable' : 'dead';
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(Math.floor(pid)), '-o', 'state='], {
      timeout: 5_000,
    });
    const classified = classifyPosixStateChar(stdout);
    if (classified) return classified;
  } catch {
    // ps exits non-zero when the pid does not exist; fall through to the signal probe.
  }
  // No ps row: trust the signal probe (a pid can be unobservable to ps but still signalable in
  // rare sandboxed setups — stay fail-closed and treat alive as servable).
  return alive ? 'servable' : 'dead';
}
